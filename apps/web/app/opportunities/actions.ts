"use server";

import { redirect } from "next/navigation";
import { recordDecision } from "@/lib/radar";

/** Yes/No from the detail panel. Runs on the server, so the API key never reaches the browser. */
export async function decide(form: FormData) {
  const id = String(form.get("opportunityId") ?? "");
  const answer = form.get("answer");
  const back = String(form.get("returnTo") ?? "/opportunities");
  if (!id || (answer !== "watch" && answer !== "pass")) throw new Error("Bad decision request");
  await recordDecision(id, answer, "web (staging)");
  // Only return to our own page; never to a URL taken from the form as-is.
  redirect(back.startsWith("/opportunities") && !back.startsWith("//") ? back : "/opportunities");
}
