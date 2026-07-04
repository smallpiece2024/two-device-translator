/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { ChatTimeline } from "@/components/ChatTimeline/ChatTimeline";
import type { MessageView } from "@/app/(public)/room/[roomId]/reducer";

function buildMessage(overrides: Partial<MessageView> = {}): MessageView {
  return {
    messageId: "msg-1",
    speakerParticipantId: "participant-other",
    speakerName: "相手さん",
    sourceLanguage: "en-US",
    originalText: "Hello",
    displayText: "こんにちは",
    displayLanguage: "ja-JP",
    isOwnMessage: false,
    createdAt: "2026-07-04T03:04:00.000Z",
    ...overrides,
  };
}

describe("ChatTimeline", () => {
  it("空状態ではプレースホルダを表示する", () => {
    render(<ChatTimeline messages={[]} interim={null} ownParticipantId="participant-self" />);

    expect(screen.getByText("まだメッセージがありません")).toBeInTheDocument();
  });

  it("自分のメッセージは右寄せバブルで話者名を表示しない", () => {
    const message = buildMessage({
      messageId: "msg-own",
      speakerParticipantId: "participant-self",
      speakerName: "自分",
      displayText: "こんにちは、自分です",
      isOwnMessage: true,
    });

    render(
      <ChatTimeline
        messages={[message]}
        interim={null}
        ownParticipantId="participant-self"
      />,
    );

    const row = screen.getByText("こんにちは、自分です").closest("li");
    expect(row).toHaveAttribute("data-own", "true");
    expect(screen.queryByText("自分")).not.toBeInTheDocument();
  });

  it("相手のメッセージは左寄せバブルで話者名を表示する", () => {
    const message = buildMessage();

    render(
      <ChatTimeline
        messages={[message]}
        interim={null}
        ownParticipantId="participant-self"
      />,
    );

    const row = screen.getByText("こんにちは").closest("li");
    expect(row).toHaveAttribute("data-own", "false");
    expect(screen.getByText("相手さん")).toBeInTheDocument();
  });

  it("interim（認識途中）は淡色イタリック表示のバブルとして表示される", () => {
    render(
      <ChatTimeline
        messages={[]}
        interim="今しゃべっている途中の内容"
        ownParticipantId="participant-self"
      />,
    );

    const interimNode = screen.getByText("今しゃべっている途中の内容");
    expect(interimNode).toBeInTheDocument();
    expect(screen.getByLabelText("認識途中")).toBeInTheDocument();
  });

  it("messagesとinterimが両方存在する場合はどちらも表示される", () => {
    const message = buildMessage({ messageId: "msg-both" });

    render(
      <ChatTimeline
        messages={[message]}
        interim="続きを認識中"
        ownParticipantId="participant-self"
      />,
    );

    expect(screen.getByText("こんにちは")).toBeInTheDocument();
    expect(screen.getByText("続きを認識中")).toBeInTheDocument();
  });
});
