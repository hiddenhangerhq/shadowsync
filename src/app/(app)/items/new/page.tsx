import { createItemAction } from "../actions";

export default async function NewItem({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  return (
    <>
      <h1>New item</h1>
      <form action={createItemAction} className="card">
        {error && <p className="err">A title is required.</p>}
        <label className="f">Title<input className="input" name="title" required /></label>
        <div className="grid c2">
          <label className="f">SKU<input className="input" name="sku" placeholder="TEST-1 for a test item" /></label>
          <label className="f">COGS ($)<input className="input" name="cogs" inputMode="decimal" /></label>
        </div>
        <label className="f">Purchase location<input className="input" name="purchaseLocation" /></label>
        <label className="f">Category<input className="input" name="category" /></label>
        <button className="btn primary" style={{ width: "100%" }}>Save draft &amp; add photos</button>
      </form>
    </>
  );
}
