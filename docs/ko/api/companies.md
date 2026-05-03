---
title: Companies
summary: Company CRUD endpoint
---

# Companies

Paperclip instance 안의 company를 관리합니다.

## List / Get

```http
GET /api/companies
GET /api/companies/{companyId}
```

현재 user/agent가 접근 가능한 company 목록과 상세 정보를 반환합니다.

## Create Company

```http
POST /api/companies

{
  "name": "My AI Company",
  "description": "An autonomous marketing agency"
}
```

## Update Company

```http
PATCH /api/companies/{companyId}

{
  "name": "Updated Name",
  "description": "Updated description",
  "budgetMonthlyCents": 100000,
  "logoAssetId": "b9f5e911-6de5-4cd0-8dc6-a55a13bc02f6"
}
```

## Upload Company Logo

```http
POST /api/companies/{companyId}/logo
Content-Type: multipart/form-data
```

지원 content type:

- `image/png`
- `image/jpeg`
- `image/jpg`
- `image/webp`
- `image/gif`
- `image/svg+xml`

업로드 후 반환된 `assetId`를 `logoAssetId`로 PATCH하면 회사 로고가 설정됩니다.

## Archive Company

```http
POST /api/companies/{companyId}/archive
```

archive된 company는 기본 목록에서 숨겨집니다.

## 주요 필드

| Field | 설명 |
| --- | --- |
| `id` | company ID |
| `name` | company 이름 |
| `description` | 설명 |
| `status` | `active`, `paused`, `archived` |
| `logoAssetId` | 저장된 로고 asset ID |
| `logoUrl` | 로고 content path |
| `budgetMonthlyCents` | 월 예산 한도 |
| `createdAt` / `updatedAt` | ISO timestamp |
