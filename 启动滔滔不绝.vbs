Option Explicit
' 无窗口启动：只是把 启动滔滔不绝.bat 藏起来跑，本身不做任何逻辑。
' 启动失败时用可见窗口重跑一次，让 BAT 里的错误信息和 pause 能被看到，
' 否则失败会卡在一个看不见的窗口里等按键。
Dim shell, files, directory, script, code
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
directory = files.GetParentFolderName(WScript.ScriptFullName)
script = files.BuildPath(directory, ChrW(&H542F) & ChrW(&H52A8) & ChrW(&H6ED4) & ChrW(&H6ED4) & ChrW(&H4E0D) & ChrW(&H7EDD) & ".bat")
If Not files.FileExists(script) Then
  MsgBox "找不到 " & script & "，请把启动脚本和本文件放在同一个文件夹里。", 16, "滔滔不绝"
  WScript.Quit 1
End If
code = shell.Run("""" & script & """", 0, True)
If code <> 0 Then shell.Run """" & script & """", 1, False
