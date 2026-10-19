import { NextResponse } from "next/server";
import type { ApiResult } from "@/lib/jobs/api";

export const respond = (r: ApiResult) => NextResponse.json(r.body, { status: r.status, headers: { "Cache-Control": "no-store" } });
