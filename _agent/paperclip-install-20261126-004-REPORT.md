# Paperclip Docker quickstart: báo cáo cài đặt (20261126-004)

**Trạng thái: BỊ CHẶN ở bước 1 (kiểm tra Docker).** Không có bước nào sau đó được chạy.

## Bằng chứng

```
$ docker ps
/usr/bin/bash: line 1: docker: command not found      (exit 127)

$ docker compose version
/usr/bin/bash: line 1: docker: command not found      (exit 127)
```

- Phiên bản docker/compose: không có (Bash không tìm thấy CLI `docker`)
- File compose dự kiến dùng: `docker/docker-compose.quickstart.yml` (chưa chạy)
- Container: không có
- HTTP localhost:3100: chưa kiểm tra (không có server)
- Log: không có

## Nguyên nhân

Bash không tìm thấy CLI `docker`. Lỗi nằm ở mức CLI/PATH, không phải daemon
không phản hồi. Chưa biết Docker Desktop đã cài nhưng thiếu trên PATH hay chưa
cài. Theo yêu cầu, tôi không tự tìm và khởi động Docker Desktop.

## Những gì CHƯA làm (cố ý)

- Chưa đọc `.env.example` / file compose, chưa tạo file env và chưa sinh secret, nên chưa có secret nào trên đĩa.
- Chưa chạy `docker compose up`.
- Không sửa mã nguồn, không commit.

## Cách gỡ chặn

1. Cài hoặc mở Docker Desktop, chờ trạng thái "Engine running".
2. Mở terminal mới, kiểm tra `docker ps` và `docker compose version` chạy được.
3. Chạy lại tác vụ từ bước 2: tạo env và secret, kiểm tra gitignore, `up -d --build`, curl :3100.
