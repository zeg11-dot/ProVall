// Temporary diagnostic: bypasses the Stripe SDK entirely and does a raw
// fetch() to Stripe's API, to isolate whether "connection to Stripe" errors
// are an SDK/config issue or a real network problem from this project's
// edge functions. Safe to delete once the real issue is found.
Deno.serve(async () => {
  const key = Deno.env.get("STRIPE_SECRET_KEY") || "";
  const report: Record<string, unknown> = {
    hasStripeKey: !!key,
    stripeKeyPrefix: key ? key.slice(0, 8) : null,
  };

  try {
    const start = Date.now();
    const resp = await fetch("https://api.stripe.com/v1/balance", {
      headers: { Authorization: `Bearer ${key}` },
    });
    report.tookMs = Date.now() - start;
    report.httpStatus = resp.status;
    report.ok = resp.ok;
    report.body = await resp.text();
  } catch (err) {
    report.fetchThrew = true;
    report.errorName = (err as Error).name;
    report.errorMessage = (err as Error).message;
    report.errorStack = (err as Error).stack;
  }

  return new Response(JSON.stringify(report, null, 2), {
    headers: { "Content-Type": "application/json" },
  });
});
