/** The application's entry point. The factory replaces this with the product's first feature. */
export function health(): { status: "ok" } {
  return { status: "ok" };
}
