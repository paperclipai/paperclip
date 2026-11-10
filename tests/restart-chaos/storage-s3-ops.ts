export type S3Operation =
  | "CreateMultipartUpload" | "UploadPart" | "CompleteMultipartUpload" | "AbortMultipartUpload" | "ListParts" | "ListMultipartUploads"
  | "PutObject" | "GetObject" | "HeadObject" | "DeleteObject" | "DeleteObjects" | "ListObjects" | "Other";

function parse(url: string) {
  return new URL(url, "http://store.invalid");
}

export function objectPath(url: string): string {
  return decodeURIComponent(parse(url).pathname);
}

export function partNumberOf(url: string): number | null {
  const value = parse(url).searchParams.get("partNumber");
  return value === null ? null : Number(value);
}

export function s3Operation(method: string, url: string): S3Operation {
  const parsed = parse(url);
  const query = parsed.searchParams;
  const isBucket = parsed.pathname.split("/").filter(Boolean).length <= 1;
  if (query.has("uploadId")) {
    switch (method) {
      case "PUT": return "UploadPart";
      case "POST": return "CompleteMultipartUpload";
      case "DELETE": return "AbortMultipartUpload";
      case "GET": return "ListParts";
      default: return "Other";
    }
  }
  if (query.has("uploads")) return method === "POST" ? "CreateMultipartUpload" : method === "GET" ? "ListMultipartUploads" : "Other";
  if (method === "POST" && query.has("delete")) return "DeleteObjects";
  if (isBucket) return method === "GET" ? "ListObjects" : "Other";
  switch (method) {
    case "PUT": return "PutObject";
    case "GET": return "GetObject";
    case "HEAD": return "HeadObject";
    case "DELETE": return "DeleteObject";
    default: return "Other";
  }
}
