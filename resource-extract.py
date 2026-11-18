"""Read document data without launching Office or executing document macros."""
import json
import os
import sys
import zipfile
import unicodedata
from collections import Counter
import xml.etree.ElementTree as ET


def emit(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


def text_looks_suspicious(text):
    characters = [char for char in text if not char.isspace()]
    if not characters:
        return True
    invalid = sum(char == "\ufffd" or unicodedata.category(char) in {"Cc", "Co", "Cs", "Cn"} for char in characters)
    if invalid / len(characters) > 0.02:
        return True
    # Broken PDF font mappings can return valid Unicode, e.g. an entire page of 'œ'.
    letters = [char for char in characters if char.isalnum()]
    if len(letters) >= 60:
        counts = Counter(letters)
        if len(counts) <= 4 or counts.most_common(1)[0][1] / len(letters) > 0.45:
            return True
    return False


def extract(path, extension, temporary, max_pages, max_chars, max_ocr):
    result = {"parser": extension, "pages": [], "warnings": [], "truncated": False}
    used = 0
    if extension == "pdf":
        import pypdfium2 as pdfium
        from pypdf import PdfReader
        document = pdfium.PdfDocument(path)
        try:
            reader = PdfReader(path)
        except Exception:
            reader = None
            result["warnings"].append("PDF 文字层无法解析，已尝试按页面识字。")
        result["totalPages"] = len(document)
        ocr_count = 0
        try:
            for index in range(min(len(document), max_pages)):
                page = document[index]
                try:
                    text = (reader.pages[index].extract_text() or "").replace("\r\n", "\n").strip() if reader is not None else ""
                except Exception:
                    text = ""
                suspect = bool(text.strip()) and text_looks_suspicious(text)
                if suspect:
                    result["warnings"].append(f"第{index + 1}页文字层疑似乱码，已改用页面识字。")
                    text = ""
                item = {"locator": f"第{index + 1}页", "page": index + 1, "text": text[:max(0, max_chars - used)]}
                used += len(item["text"])
                if len(text) > len(item["text"]):
                    result["truncated"] = True
                if not text.strip() and ocr_count < max_ocr:
                    width, height = page.get_size()
                    scale = min(3, 2400 / max(width, height))
                    bitmap = page.render(scale=scale)
                    try:
                        image_path = os.path.join(temporary, f"page-{index + 1}.png")
                        bitmap.to_pil().save(image_path)
                        item["ocrImage"] = image_path
                    finally:
                        bitmap.close()
                    ocr_count += 1
                elif not text.strip():
                    result["truncated"] = True
                    if not any("OCR" in warning for warning in result["warnings"]):
                        result["warnings"].append(f"OCR 每次最多处理 {max_ocr} 页，其余图片页未提取文字。")
                result["pages"].append(item)
                page.close()
                emit({"progress": {"stage": "extract", "current": index + 1, "total": len(document), "detail": f"提取第 {index + 1}/{len(document)} 页"}})
                if used >= max_chars:
                    result["truncated"] = index + 1 < len(document) or result["truncated"]
                    break
            if len(result["pages"]) < len(document):
                result["truncated"] = True
                result["warnings"].append(f"本次提取前 {len(result['pages'])}/{len(document)} 页，其余页面未提取。")
        finally:
            document.close()
        result["parser"] = "pypdf"
    elif extension == "docx":
        ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
        with zipfile.ZipFile(path) as archive:
            info = archive.getinfo("word/document.xml")
            if info.file_size > 30 * 1024 * 1024:
                raise ValueError("DOCX 正文过大，请拆分文档。")
            content = archive.read(info)
            if b"<!DOCTYPE" in content.upper():
                raise ValueError("不支持含外部实体的文档。")
            tree = ET.fromstring(content)
            heading, paragraph_index, table_index = "", 0, 0
            body = tree.find("w:body", ns)
            for element in body:
                tag = element.tag.split("}")[-1]
                if tag == "p":
                    paragraph_index += 1
                    pieces = []
                    for node in element.iter():
                        local = node.tag.split("}")[-1]
                        if local == "t":
                            pieces.append(node.text or "")
                        elif local in ["br", "cr"]:
                            pieces.append("\n")
                        elif local == "tab":
                            pieces.append("\t")
                    text = "".join(pieces).strip()
                    style = element.find("w:pPr/w:pStyle", ns)
                    if style is not None and any(word in style.get("{" + ns["w"] + "}val", "").lower() for word in ["heading", "title", "标题"]):
                        heading = text
                    locator = (heading[:80] + " · " if heading else "") + f"第{paragraph_index}段"
                elif tag == "tbl":
                    table_index += 1
                    rows = []
                    for row in element.findall("w:tr", ns):
                        cells = [" ".join(node.text or "" for node in cell.findall(".//w:t", ns)).strip() for cell in row.findall("w:tc", ns)]
                        rows.append(" | ".join(cells))
                    text = "\n".join(rows).strip()
                    locator = (heading[:80] + " · " if heading else "") + f"表{table_index}"
                else:
                    continue
                if text:
                    available = max(0, max_chars - used)
                    result["pages"].append({"locator": locator, "text": text[:available]})
                    used += min(available, len(text))
                    if len(text) > available:
                        result["truncated"] = True
                    if used >= max_chars or len(result["pages"]) >= max_pages:
                        result["truncated"] = True
                        break
            result["warnings"].append("DOCX 按章节、段落与表格定位，页码取决于排版；页眉、批注和嵌入对象未提取。")
        result["parser"] = "docx-xml"
    return result


if __name__ == "__main__":
    try:
        value = extract(sys.argv[1], sys.argv[2], sys.argv[3], *map(int, sys.argv[4:7]))
        emit({"result": value})
    except ImportError:
        emit({"error": "本地 Python 缺少 pypdf 或 pypdfium2 文档解析组件。"})
        sys.exit(1)
    except Exception:
        emit({"error": "文档无法解析，文件可能损坏、加密或格式不受支持。"})
        sys.exit(1)
