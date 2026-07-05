/** @jest-environment jsdom */
/**
 * `src/app/(public)/join/[inviteToken]/page.tsx`（JoinPage）の単体テスト。
 *
 * 内部の `isInviteValid` ゲート（招待の期限・room活動状態の判定）を、
 * `@/lib/supabase/admin` の `getSupabaseAdminClient` をモックして検証する
 * （`tests/unit/guest-join-route.test.ts` と同様、実 Supabase 接続は行わない）。
 * `JoinInviteForm` は `useRouter` 等を使う Client Component のため、
 * `tests/unit/JoinForm.test.tsx` の流儀でモックしてゲート結果のみを検証する。
 */
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import JoinPage from "@/app/(public)/join/[inviteToken]/page";

jest.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdminClient: jest.fn(),
}));

jest.mock("@/app/(public)/join/[inviteToken]/JoinInviteForm", () => ({
  JoinInviteForm: (props: { inviteToken: string }) => (
    <div data-testid="join-invite-form-mock" data-invite-token={props.inviteToken} />
  ),
}));

const getSupabaseAdminClientMock = getSupabaseAdminClient as jest.MockedFunction<
  typeof getSupabaseAdminClient
>;

type InviteResult = {
  data:
    | {
        expires_at: string;
        room: { status?: string } | { status?: string }[] | null;
      }
    | null;
  error: { message: string } | null;
};

function setupSupabaseMock(inviteResult: InviteResult) {
  const maybeSingle = jest.fn().mockResolvedValue(inviteResult);
  const eq = jest.fn().mockReturnValue({ maybeSingle });
  const select = jest.fn().mockReturnValue({ eq });
  const from = jest.fn().mockReturnValue({ select });

  getSupabaseAdminClientMock.mockReturnValue({
    from,
  } as unknown as ReturnType<typeof getSupabaseAdminClient>);

  return { from, select, eq, maybeSingle };
}

describe("JoinPage / isInviteValid", () => {
  const futureIso = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const pastIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("有効な招待（期限内・room activeオブジェクト形状）→ JoinInviteFormが表示される", async () => {
    setupSupabaseMock({
      data: { expires_at: futureIso, room: { status: "active" } },
      error: null,
    });

    const result = await JoinPage({ params: Promise.resolve({ inviteToken: "tok-valid" }) });
    render(result);

    const form = screen.getByTestId("join-invite-form-mock");
    expect(form).toHaveAttribute("data-invite-token", "tok-valid");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("トークン不存在（data: null）→ フォーム非表示・エラー画面を表示する", async () => {
    setupSupabaseMock({ data: null, error: null });

    const result = await JoinPage({ params: Promise.resolve({ inviteToken: "tok-missing" }) });
    render(result);

    expect(screen.queryByTestId("join-invite-form-mock")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "この招待リンクは無効か、有効期限が切れています。招待した相手に新しいリンクの発行を依頼してください。",
    );
    expect(screen.getByText("招待リンクが無効です")).toBeInTheDocument();
  });

  it("期限切れ（expires_atが過去）→ フォーム非表示・エラー画面を表示する", async () => {
    setupSupabaseMock({
      data: { expires_at: pastIso, room: { status: "active" } },
      error: null,
    });

    const result = await JoinPage({ params: Promise.resolve({ inviteToken: "tok-expired" }) });
    render(result);

    expect(screen.queryByTestId("join-invite-form-mock")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("room非active（statusがended）→ フォーム非表示・エラー画面を表示する", async () => {
    setupSupabaseMock({
      data: { expires_at: futureIso, room: { status: "ended" } },
      error: null,
    });

    const result = await JoinPage({ params: Promise.resolve({ inviteToken: "tok-ended" }) });
    render(result);

    expect(screen.queryByTestId("join-invite-form-mock")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("クエリエラー時はフォーム非表示・エラー画面を表示する", async () => {
    setupSupabaseMock({ data: null, error: { message: "db error" } });

    const result = await JoinPage({ params: Promise.resolve({ inviteToken: "tok-error" }) });
    render(result);

    expect(screen.queryByTestId("join-invite-form-mock")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("roomがネストselectで配列形状（[{status:'active'}]）で返る場合もArray.isArray分岐で有効判定される", async () => {
    setupSupabaseMock({
      data: { expires_at: futureIso, room: [{ status: "active" }] },
      error: null,
    });

    const result = await JoinPage({ params: Promise.resolve({ inviteToken: "tok-array" }) });
    render(result);

    const form = screen.getByTestId("join-invite-form-mock");
    expect(form).toHaveAttribute("data-invite-token", "tok-array");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("roomが配列形状かつ非active（[{status:'ended'}]）の場合はエラー画面を表示する", async () => {
    setupSupabaseMock({
      data: { expires_at: futureIso, room: [{ status: "ended" }] },
      error: null,
    });

    const result = await JoinPage({ params: Promise.resolve({ inviteToken: "tok-array-ended" }) });
    render(result);

    expect(screen.queryByTestId("join-invite-form-mock")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });
});
