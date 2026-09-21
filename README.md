# TripMeet AI Backend

Backend serverless independiente para obtener recomendaciones turísticas con Gemini.

## Requisitos

- Node.js 20+
- Vercel CLI (`npm install -g vercel`)
- Una API key de Gemini

## Instalación y configuración

```bash
npm install
copy .env.example .env
```

Edita `.env` y asigna tu clave a `GEMINI_API_KEY`. Nunca subas ese archivo al repositorio.

## Ejecutar localmente

```bash
vercel dev
```

El endpoint estará disponible en `http://localhost:3000/api/recommendPlaces`.

### curl en Windows

```powershell
$body = @{ interests = @("Naturaleza", "Aventura", "Fotografía"); additionalPreferences = "Quiero un lugar tranquilo para caminar" } | ConvertTo-Json -Compress
$payloadPath = Join-Path $env:TEMP "tripmeet-recommend-places.json"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($payloadPath, $body, $utf8NoBom)
curl.exe -X POST http://localhost:3000/api/recommendPlaces `
	-H "Content-Type: application/json" `
	--data-binary "@$payloadPath"
```

También puedes probarlo sin `curl.exe` usando el cliente HTTP nativo de PowerShell:

```powershell
$body = @{ interests = @("Naturaleza", "Aventura", "Fotografía"); additionalPreferences = "Quiero un lugar tranquilo para caminar" } | ConvertTo-Json -Compress
Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/recommendPlaces -ContentType "application/json" -Body $body
```

### Postman

1. Crea una solicitud `POST` a `http://localhost:3000/api/recommendPlaces`.
2. En `Headers`, agrega `Content-Type: application/json`.
3. En `Body > raw > JSON`, usa:

```json
{
	"interests": ["Naturaleza", "Aventura", "Fotografía"],
	"additionalPreferences": "Quiero un lugar tranquilo para caminar"
}
```

La respuesta exitosa tiene esta forma:

```json
{
	"recommendations": [
		{
			"nombre": "...",
			"descripcion": "...",
			"motivoRecomendacion": "..."
		}
	]
}
```

## Respuestas de error

- `400`: método incorrecto, JSON inválido o intereses ausentes.
- `502`: Gemini no responde, falla la conexión o devuelve contenido inválido.
- `503`: Gemini está temporalmente saturado o se alcanzó un límite; reintenta después.
- `504`: Gemini excede el timeout configurado.
- `500`: falta la configuración del servidor o ocurre un error inesperado.

Ante errores temporales `429` o `503`, el backend realiza hasta 2 intentos con una espera de 1.5 segundos. Cada intento puede tardar hasta 12 segundos. Si la cuota diaria o mensual está agotada, los reintentos no pueden resolverlo: debes esperar a que se renueve o revisar el proyecto y sus límites en Google AI Studio.

Cuando Gemini finalmente falla, el backend conserva el código HTTP real y el body original de la API. En los logs aparecen por separado `httpStatus`, `body` y `retryAfter`; si Gemini envía el header `Retry-After`, también se reenvía al cliente. Así, `429` identifica un límite de cuota, `503` una indisponibilidad temporal y otros códigos conservan el diagnóstico específico de Gemini.