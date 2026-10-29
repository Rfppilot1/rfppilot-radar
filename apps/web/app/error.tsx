"use client";

/** Shown when Radar's API cannot be reached or a page fails; details stay in the server log. */
export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="mx-auto max-w-lg rounded-lg border border-line bg-card p-6 text-center">
      <h1 className="text-lg font-bold text-brand-dark">Radar is not responding right now</h1>
      <p className="mt-2 text-sm text-muted">
        The opportunity data could not be loaded. This is usually brief. Try again in a minute.
      </p>
      <button
        onClick={reset}
        className="mt-4 rounded-md bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-dark"
      >
        Try again
      </button>
    </div>
  );
}
