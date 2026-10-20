#!/usr/bin/env bash
# Scaffold for review-before-pr / self-check-before-pr: a real small git repo with a base
# commit on `main` (3 fix commits included, for history-based signals) and a feature branch
# `feat/payment-retry`, checked out as HEAD, carrying a real ~70-line, 3-file diff.
#
# All commit metadata (author/committer name+email, ISO dates with an explicit +00:00 offset,
# TZ=UTC) is fixed so every run of this script produces byte-identical commits, including their
# SHAs. evals/review-before-pr/mocks/opendrs/*.md and evals/self-check-before-pr/mocks/opendrs/*.md
# cite those exact SHAs, file names and line ranges, so this diff and the mocked brief agree.
set -euo pipefail
export TZ=UTC

git init -q -b main
mkdir -p src/payments tests/payments

export GIT_AUTHOR_NAME="Dana Lee" GIT_AUTHOR_EMAIL="dana@example.com"
export GIT_COMMITTER_NAME="Dana Lee" GIT_COMMITTER_EMAIL="dana@example.com"

cat > src/payments/types.ts <<'EOF'
export interface PaymentIntent {
  id: string;
  amountCents: number;
  currency: string;
  source: string;
  idempotencyKey?: string;
}
EOF

cat > src/payments/gateway.ts <<'EOF'
export interface GatewayChargeRequest {
  amountCents: number;
  currency: string;
  source: string;
  idempotencyKey: string;
}

export interface GatewayChargeResult {
  id: string;
  status: "succeeded" | "failed" | "pending";
}

export async function chargeGateway(
  req: GatewayChargeRequest,
): Promise<GatewayChargeResult> {
  const response = await fetch("https://gateway.example.com/charges", {
    method: "POST",
    body: JSON.stringify(req),
  });

  if (!response.ok) {
    throw new Error(`gateway responded with ${response.status}`);
  }

  return (await response.json()) as GatewayChargeResult;
}
EOF

cat > src/payments/charge.ts <<'EOF'
import { chargeGateway } from "./gateway.js";
import type { PaymentIntent } from "./types.js";

export interface ChargeResult {
  id: string;
  status: "succeeded" | "failed";
  idempotencyKey: string;
}

export async function chargeCard(intent: PaymentIntent): Promise<ChargeResult> {
  const idempotencyKey = intent.idempotencyKey ?? intent.id;

  const result = await chargeGateway({
    amountCents: intent.amountCents,
    currency: intent.currency,
    source: intent.source,
    idempotencyKey,
  });

  return {
    id: result.id,
    status: result.status === "succeeded" ? "succeeded" : "failed",
    idempotencyKey,
  };
}
EOF

cat > tests/payments/charge.test.ts <<'EOF'
import { describe, it, expect } from "vitest";
import { chargeCard } from "../../src/payments/charge.js";

describe("chargeCard", () => {
  it("reuses the intent's idempotency key when present", async () => {
    expect(typeof chargeCard).toBe("function");
  });
});
EOF

git add -A
GIT_AUTHOR_DATE="2026-06-01T10:00:00+00:00" GIT_COMMITTER_DATE="2026-06-01T10:00:00+00:00" \
  git commit -q -m "feat(payments): initial charge flow"

# fix 409ffef: stop double charge when the gateway times out
cat > src/payments/charge.ts <<'EOF'
import { chargeGateway } from "./gateway.js";
import type { PaymentIntent } from "./types.js";

export interface ChargeResult {
  id: string;
  status: "succeeded" | "failed";
  idempotencyKey: string;
}

const pendingCharges = new Set<string>();

export async function chargeCard(intent: PaymentIntent): Promise<ChargeResult> {
  const idempotencyKey = intent.idempotencyKey ?? intent.id;

  if (pendingCharges.has(idempotencyKey)) {
    throw new Error(`charge already in flight for ${idempotencyKey}`);
  }
  pendingCharges.add(idempotencyKey);

  const result = await chargeGateway({
    amountCents: intent.amountCents,
    currency: intent.currency,
    source: intent.source,
    idempotencyKey,
  });

  return {
    id: result.id,
    status: result.status === "succeeded" ? "succeeded" : "failed",
    idempotencyKey,
  };
}
EOF
git add -A
GIT_AUTHOR_DATE="2026-07-10T10:00:00+00:00" GIT_COMMITTER_DATE="2026-07-10T10:00:00+00:00" \
  git commit -q -m "fix(payments): stop double charge when the gateway times out"

# fix 9ed4054: honour idempotency key on retried charges
cat > src/payments/charge.ts <<'EOF'
import { chargeGateway } from "./gateway.js";
import type { PaymentIntent } from "./types.js";

export interface ChargeResult {
  id: string;
  status: "succeeded" | "failed";
  idempotencyKey: string;
}

const pendingCharges = new Set<string>();

export async function chargeCard(intent: PaymentIntent): Promise<ChargeResult> {
  const idempotencyKey = intent.idempotencyKey ?? intent.id;

  if (pendingCharges.has(idempotencyKey)) {
    throw new Error(`charge already in flight for ${idempotencyKey}`);
  }
  pendingCharges.add(idempotencyKey);

  try {
    const result = await chargeGateway({
      amountCents: intent.amountCents,
      currency: intent.currency,
      source: intent.source,
      idempotencyKey,
    });

    return {
      id: result.id,
      status: result.status === "succeeded" ? "succeeded" : "failed",
      idempotencyKey,
    };
  } finally {
    pendingCharges.delete(idempotencyKey);
  }
}
EOF
git add -A
GIT_AUTHOR_DATE="2026-08-14T10:00:00+00:00" GIT_COMMITTER_DATE="2026-08-14T10:00:00+00:00" \
  git commit -q -m "fix(payments): honour idempotency key on retried charges"

# fix b80c82f: surface 5xx as retryable
cat > src/payments/gateway.ts <<'EOF'
export interface GatewayChargeRequest {
  amountCents: number;
  currency: string;
  source: string;
  idempotencyKey: string;
}

export interface GatewayChargeResult {
  id: string;
  status: "succeeded" | "failed" | "pending";
}

export async function chargeGateway(
  req: GatewayChargeRequest,
): Promise<GatewayChargeResult> {
  const response = await fetch("https://gateway.example.com/charges", {
    method: "POST",
    body: JSON.stringify(req),
  });

  if (!response.ok && !isRetryableStatus(response.status)) {
    throw new Error(`gateway responded with ${response.status}`);
  }

  return (await response.json()) as GatewayChargeResult;
}

export function isRetryableStatus(status: number): boolean {
  return status >= 500;
}
EOF
git add -A
GIT_AUTHOR_DATE="2026-08-20T10:00:00+00:00" GIT_COMMITTER_DATE="2026-08-20T10:00:00+00:00" \
  git commit -q -m "fix(gateway): surface 5xx as retryable"

# fake a remote-tracking ref for origin/main with no real remote configured, so
# `git diff origin/main...HEAD` (what the prompt and SKILL.md both expect as the base) works.
git update-ref refs/remotes/origin/main refs/heads/main

# feature branch: a real, modest change (3 files, ~70 changed lines) reviewed by the eval
export GIT_AUTHOR_NAME="Jordan Park" GIT_AUTHOR_EMAIL="dev@example.com"
export GIT_COMMITTER_NAME="Jordan Park" GIT_COMMITTER_EMAIL="dev@example.com"
git checkout -q -b feat/payment-retry

cat > src/payments/charge.ts <<'EOF'
import { chargeGateway } from "./gateway.js";
import type { PaymentIntent } from "./types.js";

export interface ChargeResult {
  id: string;
  status: "succeeded" | "failed";
  idempotencyKey: string;
}

export interface ChargeOptions {
  retryIdempotencyKey?: string;
}

const pendingCharges = new Set<string>();

export async function chargeCard(
  intent: PaymentIntent,
  opts: ChargeOptions = {},
): Promise<ChargeResult> {
  const idempotencyKey = opts.retryIdempotencyKey ?? intent.idempotencyKey ?? intent.id;
  const isRetry = Boolean(opts.retryIdempotencyKey);

  if (!isRetry) {
    if (pendingCharges.has(idempotencyKey)) {
      throw new Error(`charge already in flight for ${idempotencyKey}`);
    }
    pendingCharges.add(idempotencyKey);
  }

  try {
    const result = await chargeGateway({
      amountCents: intent.amountCents,
      currency: intent.currency,
      source: intent.source,
      idempotencyKey,
    });

    return {
      id: result.id,
      status: result.status === "succeeded" ? "succeeded" : "failed",
      idempotencyKey,
    };
  } finally {
    if (!isRetry) {
      pendingCharges.delete(idempotencyKey);
    }
  }
}
EOF

cat > src/payments/retry.ts <<'EOF'
import { chargeCard } from "./charge.js";
import type { PaymentIntent } from "./types.js";
import type { ChargeResult } from "./charge.js";

export interface RetryOptions {
  maxAttempts?: number;
  delayMs?: number;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_DELAY_MS = 200;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry a charge a bounded number of times, reusing the same idempotency key
 * on every attempt so the gateway treats retries as the same logical charge.
 */
export async function chargeCardWithRetry(
  intent: PaymentIntent,
  opts: RetryOptions = {},
): Promise<ChargeResult> {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const delayMs = opts.delayMs ?? DEFAULT_DELAY_MS;
  const idempotencyKey = intent.idempotencyKey ?? intent.id;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await chargeCard(intent, { retryIdempotencyKey: idempotencyKey });
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        await wait(delayMs * attempt);
      }
    }
  }

  throw lastError;
}
EOF

cat > src/payments/gateway.ts <<'EOF'
export interface GatewayChargeRequest {
  amountCents: number;
  currency: string;
  source: string;
  idempotencyKey: string;
}

export interface GatewayChargeResult {
  id: string;
  status: "succeeded" | "failed" | "pending";
}

export async function chargeGateway(
  req: GatewayChargeRequest,
): Promise<GatewayChargeResult> {
  const response = await fetch("https://gateway.example.com/charges", {
    method: "POST",
    body: JSON.stringify(req),
  });

  if (!response.ok && !isRetryableStatus(response.status)) {
    throw new Error(`gateway responded with ${response.status}`);
  }

  return (await response.json()) as GatewayChargeResult;
}

export function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 429;
}
EOF

git add -A
GIT_AUTHOR_DATE="2026-10-20T09:00:00+00:00" GIT_COMMITTER_DATE="2026-10-20T09:00:00+00:00" \
  git commit -q -m "feat(payments): retry charge on transient gateway errors"
