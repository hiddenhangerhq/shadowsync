import { redirect } from "next/navigation";
import { currentUser } from "@/lib/data";
import Nav from "@/components/Nav";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  if (!(await currentUser())) redirect("/login");
  return (
    <>
      <Nav />
      <main className="wrap">{children}</main>
    </>
  );
}
