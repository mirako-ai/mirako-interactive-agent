import type { ChatRequestError } from "./chat/request";

export function corsPreflightResponse() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

export function streamHeaders() {
  return {
    ...corsHeaders(),
    "cache-control": "no-store",
  };
}

export function jsonResponse(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      ...corsHeaders(),
      "cache-control": "no-store",
    },
  });
}

export function requestError(error: ChatRequestError) {
  return jsonError(error.message, error.status, error.code, error.param);
}

export function jsonError(message: string, status: number, code: string, param?: string) {
  return jsonResponse(
    {
      error: {
        message,
        code,
        param: param ?? null,
      },
    },
    status,
  );
}

export function requireApiKey(request: Request, env: Env): Response | null {
  const configuredApiKey = env.API_KEY?.trim();
  if (!configuredApiKey) {
    return jsonError("API key is not configured", 500, "server_error");
  }

  const suppliedApiKey = extractApiKey(request);
  if (!suppliedApiKey) {
    return authenticationError("Missing API key");
  }

  if (!constantTimeEqual(suppliedApiKey, configuredApiKey)) {
    return authenticationError("Invalid API key");
  }

  return null;
}

function extractApiKey(request: Request) {
  const authorization = request.headers.get("authorization")?.trim();
  const bearerMatch = authorization?.match(/^Bearer\s+(.+)$/i);
  if (bearerMatch?.[1]?.trim()) {
    return bearerMatch[1].trim();
  }

  const apiKey = request.headers.get("x-api-key")?.trim();
  return apiKey && apiKey.length > 0 ? apiKey : null;
}

function authenticationError(message: string) {
  const response = jsonError(message, 401, "authentication_error");
  response.headers.set("www-authenticate", 'Bearer realm="mirako-interactive-agent"');
  return response;
}

function constantTimeEqual(left: string, right: string) {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let diff = leftBytes.length ^ rightBytes.length;

  for (let index = 0; index < length; index += 1) {
    diff |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }

  return diff === 0;
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type, x-api-key",
  };
}
