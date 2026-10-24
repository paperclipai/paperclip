# Paperclip Task Exporter

Build a self-contained Windows x64 executable:

```powershell
dotnet publish tools/PaperclipExport/PaperclipExport.csproj -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:DebugType=None -p:DebugSymbols=false -o publish
```

Run `PaperclipExport.exe NOV-88`. The exporter reads its bearer token from `%USERPROFILE%\.paperclip\auth.json`, queries the configured Paperclip instance, and writes `D:\Users\NOverhead\Uploads\Paperclip\Tasks\NOV-88.zip`. It creates the directory when needed and replaces an existing archive only after the temporary archive is complete.

The archive contains the task, comments, activity, runs, documents, attachment metadata, and run event/log responses. Missing or inaccessible API sections are recorded in `ERRORS.txt`.
