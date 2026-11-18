export const COLLECTIONS = Object.freeze({ fact: '社会事实', knowledge: '知识与方法', personal: '个人与项目', opinion: '观点与经验', experience: '观点与经验', analysis: '观点与经验', hypothesis: '观点与经验' });
const statuses = ['verified', 'uncertain', 'user_statement', 'document_statement', 'reviewed'];
const normalized = value => String(value ?? '').replace(/\s+/g, '');
const text = (value, max = 300) => typeof value === 'string' && value.trim() && value.length <= max && !/<\/?[a-z][^>]*>|!\[/i.test(value);

export function isOwnDocumentStatement(content) {
  return typeof content === 'string' && /(?:我(?:自己|本人)?的|本人(?:的)?)(?:简历|履历|个人资料|学习记录|成绩单|课程记录|项目资料|项目记录|文档|资料)|(?:这|该)(?:份|个)?(?:简历|履历|文档|资料).{0,5}(?:是我|属于我)/.test(content)
    && !/(?:不是|并非|不属于)我|假设|假如|角色扮演|朋友的|同事的|别人的|他人的/.test(content);
}

export function normalizeClaimPolicy(claim) {
  const kind = claim.kind ?? (claim.status === 'user_statement' ? 'personal' : 'fact');
  const attributed = ['opinion', 'experience', 'hypothesis'].includes(kind);
  const basis = claim.basis ?? (claim.status === 'user_statement' || claim.status === 'document_statement' || attributed ? 'attributed'
    : kind === 'analysis' ? 'derivation' : 'direct');
  return { kind, attribution: claim.attribution ?? (claim.status === 'user_statement' ? '用户' : ''),
    reviewState: claim.reviewState ?? (claim.status === 'uncertain' ? 'disputed' : 'accepted'),
    basis,
    ...(claim.ownershipSourceId ? { ownershipSourceId: claim.ownershipSourceId } : {}),
    ...(claim.premises ? { premises: claim.premises } : {}),
    ...(claim.sourceAssessment ? { sourceAssessment: claim.sourceAssessment } : {}) };
}

export function claimPolicyError(claim, sources) {
  if (!claim || !statuses.includes(claim.status)) return '知识内容状态无效。';
  const policy = normalizeClaimPolicy(claim);
  if (typeof policy.kind !== 'string' || !Object.hasOwn(COLLECTIONS, policy.kind) || !['accepted', 'needs_context', 'disputed'].includes(policy.reviewState)
    || !['direct', 'explanation', 'derivation', 'attributed'].includes(policy.basis)) return '知识分类或审核依据无效。';
  if (claim.status === 'reviewed' && !claim.kind) return '新收录内容必须指定知识类型。';
  if (claim.status === 'reviewed' && ['personal', 'opinion', 'experience', 'hypothesis', 'analysis'].includes(policy.kind) && !text(policy.attribution)) return '请说明这条内容的主体、作者或分析归属。';
  if (policy.attribution && !text(policy.attribution)) return '知识归属格式无效。';
  if (policy.ownershipSourceId && (typeof policy.ownershipSourceId !== 'string' || !/^[a-zA-Z0-9_-]{8,80}$/.test(policy.ownershipSourceId))) return '本人资料的归属来源编号无效。';
  if (policy.premises && !text(policy.premises, 2000)) return '推导前提格式无效。';
  if (policy.sourceAssessment && (typeof policy.sourceAssessment !== 'object' || Array.isArray(policy.sourceAssessment)
    || typeof policy.sourceAssessment.sourceId !== 'string' || !/^[a-zA-Z0-9_-]{8,80}$/.test(policy.sourceAssessment.sourceId) || !['high', 'primary'].includes(policy.sourceAssessment.reliability)
    || !text(policy.sourceAssessment.reason, 2000))) return '本地原始资料的出处评估无效。';
  if (claim.status !== 'reviewed' && ((claim.status === 'user_statement' && policy.kind !== 'personal')
    || (['verified', 'uncertain', 'document_statement'].includes(claim.status) && policy.kind !== 'fact'))) return '旧版状态与内容类型不一致，请按分类审核。';
  if (!Array.isArray(claim.evidence) || !claim.evidence.length || claim.evidence.length > 12) return '每条内容必须有可追溯依据。';
  for (const evidence of claim.evidence) {
    const source = sources.get(evidence?.sourceId);
    if (!source || typeof evidence.quote !== 'string' || evidence.quote.length > 6000 || normalized(evidence.quote).length < 4
      || !normalized(source.content).includes(normalized(evidence.quote)) || !text(evidence.locator, 500)
      || !['supports', 'contradicts'].includes(evidence.relation)) return '引用原文无法核对，未写入知识库。';
    if (source.kind === 'document' && evidence.locator !== source.document?.locator) return '本地资料引用位置与原文不一致。';
    if (claim.status === 'verified' && (source.kind !== 'web' || !['medium', 'high', 'primary'].includes(source.reliability ?? 'medium'))) return '已核实结论必须有可评估的网页证据。';
    if (claim.status === 'user_statement' && source.kind !== 'user') return '用户陈述必须引用用户原话。';
    if (claim.status === 'document_statement' && source.kind !== 'document') return '文件记载必须引用本地原文。';
    if (claim.status !== 'reviewed') continue;
    if (policy.kind === 'personal') {
      if (source.kind === 'user') continue;
      const owner = sources.get(policy.ownershipSourceId);
      if (source.kind !== 'document' || owner?.kind !== 'user' || !isOwnDocumentStatement(owner.content)
        || !owner.content.includes(source.document?.resourceId)) return '本人文档必须关联用户明确指定这份资料的真实原话。';
    }
    if (policy.kind === 'knowledge' && !(source.kind === 'document' || source.kind === 'web')) return '知识原理需要网页或本地资料作为依据。';
    if (policy.kind === 'fact') {
      const assessment = policy.sourceAssessment;
      const supported = source.kind === 'web' && ['medium', 'high', 'primary'].includes(source.reliability ?? 'medium');
      const originalDocument = source.kind === 'document' && assessment?.sourceId === source.id
        && ['high', 'primary'].includes(assessment.reliability) && text(assessment.reason, 2000);
      const attributed = (source.kind === 'document' || source.kind === 'web') && policy.basis === 'attributed' && text(policy.attribution);
      if (!supported && !originalDocument && !attributed) return '公共事实需要可靠原文；普通文件可以按作者或报告记载收录。';
    }
    if (['opinion', 'experience', 'hypothesis'].includes(policy.kind) && policy.basis !== 'attributed') return '观点、经验和假说必须按提出者归属保存。';
  }
  if (claim.status !== 'uncertain' && policy.reviewState !== 'disputed' && !claim.evidence.some(evidence => evidence.relation === 'supports')) return '这条内容缺少支持依据。';
  if (claim.status === 'reviewed' && policy.basis === 'derivation' && !text(policy.premises, 2000)) return '推导或分析需要保留可检查的前提与推断关系。';
  if (claim.status === 'reviewed' && policy.kind === 'analysis' && (policy.basis !== 'derivation' || !/助手/.test(String(policy.attribution || '')))) return '助手分析必须保留分析归属与推断前提。';
  return null;
}

export const POLICY_RULES = `按内容而非来源渠道选择四个内部审核角色，共用来源，只有知识库管理员提交修改。新内容使用status="reviewed"，每段必须有kind:"fact|knowledge|personal|opinion|experience|analysis|hypothesis"、attribution:"主体/作者/教材名称（知识可写通用原理）"、reviewState:"accepted|needs_context|disputed"、basis:"direct|explanation|derivation|attributed"；保留scope、asOf和evidence。事实核查员核对对象、数字、时间与适用范围，可靠原文可以是网页或能说明出处的本地原始文件。普通报告仅按其记载收录，basis=attributed且attribution说明报告作者；本地原始文档作为公共事实依据时，附sourceAssessment:{sourceId, reliability:"high|primary",reason:"实际原始发布者和出处判断"}，文件名不证明权威性。知识整理员检查定义、公式、步骤、前提、推导和教学解释，可用自己的话改写，不要求正文与网页逐字相同；引用的quote仍须是连续逐字原文。知识类basis=explanation或derivation，后者附premises说明推导。其中历史、成绩、比较数字单独走fact。个人档案员接受真实用户陈述，不上网证明私事；本人文档必须ownershipSourceId关联用户明确指定这份资料为本人的真实原话（原话含资料resourceId），引用保留文档原句，学过不能扩为精通、参与不能扩为独立负责、计划不能改为完成。第三方简历不归给用户。观点编辑员保留作者、情境和边界，opinion/experience/hypothesis使用basis=attributed；助手生成的分析必须kind=analysis、attribution=助手分析、basis=derivation、premises说明来源前提，不当用户意见。观点不是尚未证实的公共事实，经验不能升为普遍定律。正文自然融入归属和重要限制，不逐段堆状态标签。混合内容分段审核，允许部分收录；拒绝项说明具体原因，避免笼统证据审查未通过。所有类型保留真实sourceId、连续quote、locator和supports/contradicts，不虚构证据。`;

// 首次启动写入记忆库的可编辑准则；之后以记忆库里的文件为准，可由用户或管理员改写。
export const DEFAULT_GUIDELINES = `# 知识库准则

版本 1 · 本文件保存在记忆库，是收录与整理的实际执行准则，可直接改写；保存后下一次整理立即生效。

## 一、收录判断：默认收，不轻易拒

默认认为材料值得收录。把内容整理清楚、标好类型与归属，比要求它先被证明更重要。
只有以下情况才拒收：
1. 引文在提供的原文里找不到，或把不相邻的句子拼成一段引文，或编造来源、数字、日期。
2. 正文与原文明确矛盾，或把明确的假设写成已经发生的事实。
3. 把他人经历写成本人经历，或把助手推测写成用户已知、用户认可。
4. 材料与要整理的问题完全无关。
其余情况一律收录：来源不够权威、只有单一来源、缺少发布日期、表述不够精确、属于观点或预测，都写入笔记并在 scope、asOf、reviewState 里如实标注。材料不足时用 gaps 说明具体缺什么，不要用拒收代替补充。

## 二、分类：按内容判断，不按来源渠道

- 事实 fact：可核对的公共事实，例如时间、地点、政策、统计、产品发布、实验结果。
- 知识与方法 knowledge：定义、原理、公式、推导、步骤、教程，教材、课程、技术文档即可作为依据。
- 个人与项目 personal：用户本人陈述、用户明确指定为本人材料的文档、本人的项目与学习记录。
- 观点与经验 opinion / experience：评价、立场、判断、经验总结、预测。
- 分析 analysis：助手自己的推理，必须归属"助手分析"并写出前提。
- 假说 hypothesis：尚未证实的推测。
一篇笔记可以有多段、每段一个 kind，但不要把互相独立的主题挤进同一段。
四类各有一个分类页：wiki/分类/社会事实、知识与方法、个人与项目、观点与经验。每篇笔记由程序自动连到自己所属的分类页，分类页再反向列出本类全部笔记；分类页开头的判定说明可以改，索引段由程序重写，不要手改。

## 三、拆分：宽泛主题一定要拆

一个问题一页。"X 是什么""X 由什么组成""X 怎么训练""X 有什么局限""X 怎么用""X 与 Y 的区别"都是不同问题，必须分页。
宽泛主题（学科、领域、技术体系、一门课、一套方法）先列出 4–6 个可独立回答的问题，按由浅入深排序，每个问题一页；第一页可以做索引或学习路线页，用 wiki 链接串起其余各页。
单次整理最多 6 页；主题更大时先做最基础的 6 页，并在 gaps 写清下一批要做什么。
每页 1–4 个自然段，一段讲清一件事，先直接回答再补背景；重要时间、版本和适用条件融入句子，不写"已核实""适用范围"这类标签。标题就是这个页回答的问题，summary 一句话。关联只连直接解释、依赖、对比、补充的页面。
解释性正文可以改写，但引文必须是连续原文，不得拼接。

## 四、更新与保留

优先补充回答同一问题的既有页，不重复建页。旧结论仍然有效就保留；被新证据取代时替换并保留引用。
本地已经能回答，不等于已经收录。新材料里有旧页没有的数字、日期、版本、前提、步骤、例子、例外或更准确的说法，就补进同一页，不要整轮跳过；只有语义完全重复才不写，重复时说明原因，不要假装整理过。
只有用户明确要求删除、合并、拆分时才改动结构，否则只增不删。人工修改过的页面不改写，把建议写进 gaps。
用户的原话和聊天记录不能被自动删除。

## 五、修订本准则

用户要求调整收录标准、审核尺度、拆分规则或笔记写法时，直接改写本文件，保留上面的小节结构，并在文末追加一行"修订：日期 · 改了什么"。
不得删除三条底线：引文必须真实；不得伪造来源、数字与日期；不得把他人经历写成本人经历。
`;
