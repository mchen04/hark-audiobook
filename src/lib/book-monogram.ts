export function titleMonogram(title: string): string {
  return (
    title
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0])
      .join("")
      .toUpperCase() || "AB"
  );
}
