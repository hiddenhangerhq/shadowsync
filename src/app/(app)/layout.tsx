import { redirect } from "next/navigation";
import { currentUser, getServices } from "@/lib/data";
import Nav from "@/components/Nav";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  if (!(await currentUser())) redirect("/login");
  // Header badge: failed + needs-you jobs. Any error (e.g. 0005 not applied yet) just hides it.
  let jobsAttention = 0;
  try {
    const c = await (await getServices()).store.jobs.counts();
    jobsAttention = c.failed + c.needs_user;
  } catch { /* hidden */ }
  return (
    <>
      <Nav jobsAttention={jobsAttention} />
      <main className="wrap">{children}</main>
    </>
  );
}
