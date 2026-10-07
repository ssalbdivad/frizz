import { cn } from "@/lib/cn";

// A screenshot of the board in a window frame. `src` is under public/img; `v` busts the cache when the
// file is re-shot, since /img is served must-revalidate but browsers still hold the old bytes until then.
export function Shot({
  src,
  alt,
  width,
  height,
  className,
  priority,
}: {
  src: string;
  alt: string;
  width: number;
  height: number;
  className?: string;
  priority?: boolean;
}) {
  return (
    <figure
      className={cn(
        "not-prose overflow-hidden rounded-2xl border border-fd-border bg-fd-card shadow-xl shadow-black/10",
        className,
      )}
    >
      <img
        src={src}
        alt={alt}
        width={width}
        height={height}
        loading={priority ? "eager" : "lazy"}
        className="block h-auto w-full"
      />
    </figure>
  );
}
