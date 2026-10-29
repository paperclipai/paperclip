using System.IO.Compression;
using System.Net.Http.Headers;
using System.Text.Json;
using System.Text.RegularExpressions;

const string BaseUrl = "http://192.168.1.21:3100";
const string ConfigPath = @"C:\Users\NOverhead\.paperclip\auth.json";
const string CompanyId = "28280247-c12f-4c06-8f73-bbd79de26a5e";
const string OutputDir = @"D:\Users\NOverhead\Uploads\Paperclip\Tasks";
if (args.Length != 1 || !Regex.IsMatch(args[0], @"^[A-Za-z0-9]+-[1-9][0-9]*$")) { Console.Error.WriteLine("Usage: PaperclipExport.exe TICKET-ID"); return 2; }
var ticket = args[0].ToUpperInvariant();
using var config = JsonDocument.Parse(await File.ReadAllTextAsync(ConfigPath));
var token = config.RootElement.GetProperty("credentials").GetProperty(BaseUrl).GetProperty("token").GetString();
if (string.IsNullOrWhiteSpace(token)) throw new InvalidOperationException("No local Paperclip token found.");
using var http = new HttpClient { BaseAddress = new Uri(BaseUrl), Timeout = TimeSpan.FromSeconds(45) };
http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
using var content = new MemoryStream(); var gaps = new List<string>();
await using (var zip = new ZipArchive(content, ZipArchiveMode.Create, true)) {
 async Task<byte[]?> Get(string path,string label) { try { var r=await http.GetAsync(path); if(!r.IsSuccessStatusCode){gaps.Add($"{label}: HTTP {(int)r.StatusCode} {r.ReasonPhrase}");return null;} return await r.Content.ReadAsByteArrayAsync(); } catch(Exception e){gaps.Add($"{label}: {e.GetType().Name}: {e.Message}");return null;} }
 async Task Save(string name,byte[]? bytes){if(bytes is null)return;var e=zip.CreateEntry(name,CompressionLevel.Optimal);await using var s=e.Open();await s.WriteAsync(bytes);}
 async Task<JsonDocument?> JsonGet(string path,string label){var b=await Get(path,label);if(b is null)return null;try{return JsonDocument.Parse(b);}catch(Exception e){gaps.Add($"{label}: invalid JSON: {e.Message}");return null;}}
 var list=await JsonGet($"/api/companies/{CompanyId}/issues?limit=500&offset=0", "Issue lookup"); JsonElement issue=default;
 if(list is not null){var root=list.RootElement;IEnumerable<JsonElement> items=root.ValueKind==JsonValueKind.Array?root.EnumerateArray():root.TryGetProperty("items",out var it)&&it.ValueKind==JsonValueKind.Array?it.EnumerateArray():[];issue=items.FirstOrDefault(x=>x.TryGetProperty("identifier",out var v)&&string.Equals(v.GetString(),ticket,StringComparison.OrdinalIgnoreCase));}
 if(issue.ValueKind!=JsonValueKind.Object){gaps.Add($"Issue {ticket} was not found in the first 500 company issues.");}
 else {
  var id=issue.GetProperty("id").GetString()!; await Save("issue.json",JsonSerializer.SerializeToUtf8Bytes(issue,new JsonSerializerOptions{WriteIndented=true}));
  await Save("comments.json",await Get($"/api/issues/{id}/comments?order=asc&limit=100","Comments"));
  await Save("activity.json",await Get($"/api/issues/{id}/activity","Activities"));
  await Save("runs.json",await Get($"/api/issues/{id}/runs","Agent runs"));
  await Save("documents.json",await Get($"/api/issues/{id}/documents","Documents"));
  var attachments=await JsonGet($"/api/issues/{id}/attachments","Attachments");
  if(attachments is not null){await Save("attachments.json",JsonSerializer.SerializeToUtf8Bytes(attachments.RootElement,new JsonSerializerOptions{WriteIndented=true}));IEnumerable<JsonElement> arr=attachments.RootElement.ValueKind==JsonValueKind.Array?attachments.RootElement.EnumerateArray():[];var ix=0;foreach(var a in arr){ix++;if(a.TryGetProperty("url",out var u)&&u.ValueKind==JsonValueKind.String&&Uri.TryCreate(u.GetString(),UriKind.Absolute,out var uri)&&uri.Host==new Uri(BaseUrl).Host)await Save($"attachments/{ix}-{Path.GetFileName(uri.LocalPath)}",await Get(uri.PathAndQuery,$"Attachment {ix} file"));}}
  var runs=await JsonGet($"/api/issues/{id}/runs","Agent runs for logs"); if(runs is not null){IEnumerable<JsonElement> rs=runs.RootElement.ValueKind==JsonValueKind.Array?runs.RootElement.EnumerateArray():runs.RootElement.TryGetProperty("items",out var ri)&&ri.ValueKind==JsonValueKind.Array?ri.EnumerateArray():[];foreach(var run in rs){if(!(run.TryGetProperty("runId",out var rv)||run.TryGetProperty("id",out rv))||rv.GetString() is not string rid)continue;await Save($"runs/{rid}/events.json",await Get($"/api/heartbeat-runs/{rid}/events?afterSeq=0&limit=10000",$"Run {rid} events"));await Save($"runs/{rid}/log.json",await Get($"/api/heartbeat-runs/{rid}/log?offset=0&limitBytes=10000000",$"Run {rid} log"));}}
 }
 if(gaps.Count>0)await Save("ERRORS.txt",System.Text.Encoding.UTF8.GetBytes(string.Join(Environment.NewLine,gaps)));
}
Directory.CreateDirectory(OutputDir);var finalPath=Path.Combine(OutputDir,ticket+".zip");var tempPath=finalPath+".tmp";await File.WriteAllBytesAsync(tempPath,content.ToArray());File.Move(tempPath,finalPath,true);Console.WriteLine($"Exported {ticket} to {finalPath} ({content.Length:N0} bytes)");if(gaps.Count>0)Console.WriteLine($"Completed with {gaps.Count} documented gap(s).");return 0;

