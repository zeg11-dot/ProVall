// Creates (or resumes) a Stripe Express connected account for a business
// and returns a hosted onboarding link. Called by an authenticated business
// owner from the client.
import Stripe from "npm:stripe@17";
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2024-06-20",
});

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing Authorization header" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Client scoped to the caller's own JWT so RLS decides what they can touch.
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );

    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (userError || !userData?.user) {
      return new Response(JSON.stringify({ error: "Not authenticated" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const user = userData.user;

    const { business_id, business_name, return_url, refresh_url } = await req.json();
    if (!return_url || !refresh_url) {
      return new Response(
        JSON.stringify({ error: "return_url and refresh_url are required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    let business;
    if (business_id) {
      const { data, error } = await supabase
        .from("businesses")
        .select("*")
        .eq("id", business_id)
        .single();
      if (error || !data) {
        return new Response(JSON.stringify({ error: "Business not found" }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      business = data;
    } else {
      if (!business_name) {
        return new Response(
          JSON.stringify({ error: "business_name is required to create a business" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      const { data, error } = await supabase
        .from("businesses")
        .insert({ owner_id: user.id, name: business_name })
        .select()
        .single();
      if (error || !data) {
        return new Response(JSON.stringify({ error: error?.message ?? "Could not create business" }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      business = data;
    }

    let stripeAccountId = business.stripe_account_id as string | null;
    if (!stripeAccountId) {
      const account = await stripe.accounts.create({
        type: "express",
        email: user.email ?? undefined,
        business_type: "company",
      });
      stripeAccountId = account.id;

      const { error: updateError } = await supabase
        .from("businesses")
        .update({ stripe_account_id: stripeAccountId })
        .eq("id", business.id);
      if (updateError) {
        return new Response(JSON.stringify({ error: updateError.message }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    const accountLink = await stripe.accountLinks.create({
      account: stripeAccountId,
      refresh_url,
      return_url,
      type: "account_onboarding",
    });

    return new Response(JSON.stringify({ url: accountLink.url, business_id: business.id }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
