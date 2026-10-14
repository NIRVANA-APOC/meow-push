# MeoW Push API Reference (offline summary)

Source: <https://www.chuckfang.com/MeoW/api_doc.html> (the page embeds an OpenAPI 3.1 spec, which is authoritative; this file summarizes it and adds notes confirmed by testing).

## Basics

- Base URL (HTTPS recommended): `https://api.chuckfang.com`; `http://api.chuckfang.com` is also available
- Methods: `GET` / `POST`; no authentication, no SDK
- Chinese characters and special characters must be URL-encoded
- HTTP status is normally 200; the business result is in the JSON `status` field

## GET

```text
GET /{nickname}/{title}/{msg}?url=&imgUrl=&msgType=&htmlHeight=
GET /{nickname}/{msg}?url=&imgUrl=&msgType=&htmlHeight=
```

- `title` defaults to `MeoW` when omitted
- Path segments must not contain `/`: the percent-encoded form `%2F` is rejected by the server front end (Tomcat) with HTTP 400 (confirmed by testing)
- `htmlHeight` only applies when `msgType=html`; default 200

## POST

```text
POST /{nickname}[/{title}]?msgType=text|html&htmlHeight=200
Content-Type: application/json
```

Supported body formats: `application/json`, `application/x-www-form-urlencoded`, `multipart/form-data`, `text/plain`.

JSON body fields:

| Field | Required | Description |
| --- | --- | --- |
| `msg` | Yes | Message content |
| `title` | No | Priority: body > path > default `MeoW` |
| `url` | No | Link opened when the notification is tapped |
| `imgUrl` | No | Notification icon (body takes priority over the query parameter); 216×216 PNG recommended |

Note: `msgType` and `htmlHeight` are always query parameters and **never** belong in the JSON body.

## Response

```json
{"status": 200, "data": true, "msg": "发送成功"}
```

| status | Meaning |
| --- | --- |
| 200 | Success (combined with `data != false`) |
| 400 | Invalid title or message parameters |
| 403 | Content blocked by policy |
| 404 | Nickname not registered |
| 429 | Sending or IP rate limit exceeded |
| 500 | Server error |

## Limits and safety

- Regular users: 1 per 3 seconds, 15 per minute, 60 per hour, 1000 per day (429 when exceeded)
- Three sends to unregistered nicknames within one day get the IP banned (stated in the 404 message) — never probe the API with random nicknames
- Avoid sending to many nicknames from a shared public IP; it may be flagged as an attack. Trusted IPs can request a whitelist entry from the developer
- Pushes are not idempotent: timeouts, connection drops, 500s, and non-JSON responses may still have been delivered — confirm before retrying
