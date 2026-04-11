#!/usr/bin/env python3
"""Google Drive 파일 업로드 스크립트.

Usage: python3 drive_upload.py <file_path> [folder_id]

ADC(Application Default Credentials)가 설정되어 있어야 합니다:
  gcloud auth application-default login --scopes=https://www.googleapis.com/auth/drive.file

출력: DRIVE_UPLOAD: <filename> -> <webViewLink>
"""
import sys
import os

def main():
    if len(sys.argv) < 2:
        print("Usage: python3 drive_upload.py <file_path> [folder_id]", file=sys.stderr)
        sys.exit(1)

    file_path = sys.argv[1]
    folder_id = sys.argv[2] if len(sys.argv) > 2 else '1MU-4RHfxiLwcepAeAZas0hl4NvN86_Xa'

    if not os.path.exists(file_path):
        print(f"ERROR: File not found: {file_path}", file=sys.stderr)
        sys.exit(1)

    # Detect MIME type
    ext = os.path.splitext(file_path)[1].lower()
    mime_map = {
        '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        '.pdf': 'application/pdf',
        '.csv': 'text/csv',
        '.json': 'application/json',
    }
    mimetype = mime_map.get(ext, 'application/octet-stream')

    try:
        from google.auth import default
        from google.auth.transport.requests import Request
        from googleapiclient.discovery import build
        from googleapiclient.http import MediaFileUpload
    except ImportError:
        print("ERROR: google-api-python-client not installed. Run: pip3 install google-api-python-client google-auth", file=sys.stderr)
        sys.exit(1)

    try:
        creds, _ = default(scopes=['https://www.googleapis.com/auth/drive.file'])
        creds.refresh(Request())
    except Exception as e:
        print(f"ERROR: ADC not configured. Run: gcloud auth application-default login --scopes=https://www.googleapis.com/auth/drive.file", file=sys.stderr)
        print(f"Detail: {e}", file=sys.stderr)
        sys.exit(1)

    svc = build('drive', 'v3', credentials=creds)
    filename = os.path.basename(file_path)

    result = svc.files().create(
        body={'name': filename, 'parents': [folder_id]},
        media_body=MediaFileUpload(file_path, mimetype=mimetype),
        fields='id,webViewLink'
    ).execute()

    print(f"DRIVE_UPLOAD: {filename} -> {result['webViewLink']}")

if __name__ == '__main__':
    main()
