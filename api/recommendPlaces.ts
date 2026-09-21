import { GoogleGenAI, Type } from "@google/genai";
import type { VercelRequest, VercelResponse } from "@vercel/node";

// Deja margen frente a maxDuration (30s en vercel.json).
// Con 2 intentos posibles, el peor caso es ~2 * REQUEST_TIMEOUT_MS + overhead,
// así que lo bajamos a 13s para no sobrepasar los 30s totales si hay retry.
const REQUEST_TIMEOUT_MS = 13_000;
const MAX_GEMINI_ATTEMPTS = 2;

type Recommendation = {
  nombre: string;
  descripcion: string;
  motivoRecomendacion: string;
};

type RequestBody = {
  interests: string[];
  additionalPreferences?: string;
};

const responseSchema = {
  type: Type.OBJECT,
  properties: {
    recommendations: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          nombre: { type: Type.STRING },
          descripcion: { type: Type.STRING },
          motivoRecomendacion: { type: Type.STRING },
        },
        required: ["nombre", "descripcion", "motivoRecomendacion"],
      },
    },
  },
  required: ["recommendations"],
};

function isRequestBody(value: unknown): value is RequestBody {
  if (!value || typeof value !== "object") return false;

  const body = value as Record<string, unknown>;
  const interests = body.interests;

  return (
    Array.isArray(interests) &&
    interests.length > 0 &&
    interests.every(
      (interest) => typeof interest === "string" && interest.trim().length > 0,
    ) &&
    (body.additionalPreferences === undefined ||
      typeof body.additionalPreferences === "string")
  );
}

function isRecommendation(value: unknown): value is Recommendation {
  if (!value || typeof value !== "object") return false;

  const recommendation = value as Record<string, unknown>;
  return ["nombre", "descripcion", "motivoRecomendacion"].every(
    (field) =>
      typeof recommendation[field] === "string" &&
      (recommendation[field] as string).trim().length > 0,
  );
}

function isRecommendationResponse(
  value: unknown,
): value is { recommendations: Recommendation[] } {
  if (!value || typeof value !== "object") return false;
  const response = value as Record<string, unknown>;
  return (
    Array.isArray(response.recommendations) &&
    response.recommendations.every(isRecommendation)
  );
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("GEMINI_TIMEOUT")),
      timeoutMs,
    );

    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function getUpstreamStatus(error: unknown): number | undefined {
  return typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof error.status === "number"
    ? error.status
    : undefined;
}

function getErrorDetails(error: unknown): {
  status?: number;
  body: unknown;
  retryAfter?: string;
} {
  const errorRecord =
    typeof error === "object" && error !== null
      ? (error as Record<string, unknown>)
      : undefined;
  const rawMessage = error instanceof Error ? error.message : String(error);
  let body: unknown = rawMessage;

  try {
    body = JSON.parse(rawMessage);
  } catch {
    // The SDK may expose a non-JSON network error message.
  }

  const headers = errorRecord?.headers;
  let retryAfter: string | undefined;
  if (headers instanceof Headers) {
    retryAfter = headers.get("Retry-After") ?? undefined;
  } else if (headers && typeof headers === "object") {
    const headerRecord = headers as Record<string, unknown>;
    const value = headerRecord["Retry-After"] ?? headerRecord["retry-after"];
    retryAfter = typeof value === "string" ? value : undefined;
  }

  return {
    status: getUpstreamStatus(error),
    body,
    retryAfter,
  };
}

// Ahora también trata el timeout como un error reintentable.
function isRetryableGeminiError(error: unknown): boolean {
  const status = getUpstreamStatus(error);
  if (status === 429 || status === 503) return true;
  return error instanceof Error && error.message === "GEMINI_TIMEOUT";
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function generateRecommendations(
  ai: GoogleGenAI,
  prompt: string,
): Promise<{ text?: string }> {
  for (let attempt = 1; attempt <= MAX_GEMINI_ATTEMPTS; attempt += 1) {
    const start = Date.now();
    try {
      const result = await withTimeout(
        ai.models.generateContent({
          model: "gemini-3.6-flash",
          contents: prompt,
          config: {
            responseMimeType: "application/json",
            responseSchema,
          },
        }),
        REQUEST_TIMEOUT_MS,
      );
      console.log(
        `Gemini respondió en intento ${attempt} después de ${Date.now() - start}ms`,
      );
      return result;
    } catch (error: unknown) {
      console.warn(
        `Gemini falló en intento ${attempt} después de ${Date.now() - start}ms:`,
        error instanceof Error ? error.message : error,
      );

      if (!isRetryableGeminiError(error) || attempt === MAX_GEMINI_ATTEMPTS) {
        throw error;
      }

      await wait(attempt * 1_500);
    }
  }

  throw new Error("GEMINI_RETRY_FAILED");
}

export default async function handler(
  request: VercelRequest,
  response: VercelResponse,
): Promise<void> {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    response.status(405).json({ error: "Method not allowed. Use POST." });
    return;
  }

  let requestBody: unknown;
  try {
    requestBody = request.body;
  } catch {
    response.status(400).json({ error: "Invalid JSON request body." });
    return;
  }

  if (!isRequestBody(requestBody)) {
    response.status(400).json({
      error:
        "Invalid request body. interests must be a non-empty array of strings.",
    });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    response.status(500).json({
      error: "Server configuration error: GEMINI_API_KEY is not configured.",
    });
    return;
  }

  const { interests, additionalPreferences } = requestBody;
  const prompt = [
    "Recomienda lugares turísticos que coincidan con los intereses y preferencias del turista.",
    "Devuelve únicamente el JSON solicitado, sin texto adicional.",
    `Intereses: ${interests.join(", ")}`,
    additionalPreferences
      ? `Preferencias adicionales: ${additionalPreferences}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const ai = new GoogleGenAI({ apiKey });
    const result = await generateRecommendations(ai, prompt);

    let parsed: unknown;
    try {
      parsed = JSON.parse(result.text ?? "");
    } catch {
      response.status(502).json({ error: "Gemini returned invalid JSON." });
      return;
    }

    if (!isRecommendationResponse(parsed)) {
      response.status(502).json({
        error: "Gemini returned JSON with an invalid recommendation format.",
      });
      return;
    }

    response.status(200).json(parsed);
  } catch (error: unknown) {
    if (error instanceof Error && error.message === "GEMINI_TIMEOUT") {
      response.status(504).json({
        error: "Gemini did not respond within the allowed time.",
      });
      return;
    }

    const details = getErrorDetails(error);
    console.error("Gemini request failed:", {
      httpStatus: details.status,
      body: details.body,
      retryAfter: details.retryAfter,
    });

    const responseStatus = details.status && details.status >= 400
      ? details.status
      : 502;
    if (details.retryAfter) {
      response.setHeader("Retry-After", details.retryAfter);
    }

    response.status(responseStatus).json({
      error: details.body,
      retryAfter: details.retryAfter,
    });
  }
}

export const config = {
  maxDuration: 30,
};