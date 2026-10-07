import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 px-6 py-32 text-center">
      <p className="font-mono text-7xl font-bold text-[var(--gold)]">404</p>
      <p className="text-lg text-fd-muted-foreground">Nothing in the queue here.</p>
      <div className="mt-4 flex gap-6 font-medium">
        <Link href="/" className="text-[var(--gold)] hover:underline">
          Home
        </Link>
        <Link href="/docs" className="text-[var(--gold)] hover:underline">
          Docs
        </Link>
      </div>
    </main>
  );
}
