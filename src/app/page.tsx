import { SHARED_PLACEHOLDER } from "@shared/index";

export default function Home() {
  return (
    <main>
      <h1>two-device-translator</h1>
      <p>プロジェクト雛形（Phase 1）</p>
      <p data-shared-check={SHARED_PLACEHOLDER} />
    </main>
  );
}
