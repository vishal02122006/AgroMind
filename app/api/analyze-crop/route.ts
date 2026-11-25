import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const pythonApiUrl = process.env.AGROMIND_PYTHON_API_URL;
  if (!pythonApiUrl) {
    return NextResponse.json(
      { error: "Structured crop triage requires a configured Python API." },
      { status: 503 },
    );
  }

  let response: Response;
  try {
    response = await fetch(
      `${pythonApiUrl.replace(/\/$/, "")}/api/analyze-crop`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
        cache: "no-store",
      },
    );
  } catch (error) {
    console.warn(
      "Structured crop triage request failed",
      error instanceof Error ? error.name : "UnknownError",
    );
    return NextResponse.json(
      { error: "The structured diagnosis service is unavailable." },
      { status: 503 },
    );
  }

  let result: unknown;
  try {
    result = await response.json();
  } catch {
    return NextResponse.json(
      { error: "The diagnosis service returned an invalid response." },
      { status: 502 },
    );
  }

  if (!response.ok) {
    return NextResponse.json(result, { status: response.status });
  }
  return NextResponse.json(result);
}
