import { type Dispatch, type RefObject, type SetStateAction } from "react";
import { MORE_REACTIONS, QUICK_REACTIONS } from "../message-menu.js";
import { uiText } from "./locale.js";
import type { PresenceView, TelegramChatRow } from "./inbox-thread.js";
import { Avatar, CloseIcon, MenuIcon, profileOnlineClass } from "./inbox-widgets.js";

export type MessageMenuState = {
  ids: string[];
  text: string;
  x: number;
  y: number;
  page: "menu" | "delete" | "forward" | "reactions";
};

export function InboxProfile(props: {
  profileRef: string | null;
  profileChat: TelegramChatRow | undefined;
  profileName: string;
  profilePhoto: string | null;
  profilePresence: PresenceView;
  profileStatus: string;
  profileChannel: string;
  profilePhone: string;
  profileUser: string;
  profileAbout: string;
  sharedChats: number;
  profileFailed: boolean;
  onClose: () => void;
}) {
  const {
    profileRef,
    profileChat,
    profileName,
    profilePhoto,
    profilePresence,
    profileStatus,
    profileChannel,
    profilePhone,
    profileUser,
    profileAbout,
    sharedChats,
    profileFailed,
    onClose,
  } = props;
  return (
    <>
      {profileRef ? (
        <div
          className="tg-info-scrim"
          onClick={onClose}
        >
          <div
            className="tg-info"
            role="dialog"
            aria-modal="true"
            aria-label={uiText("User Info")}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="tg-info-bar">
              <button
                type="button"
                className="tg-info-close"
                aria-label={uiText("Close")}
                autoFocus
                onClick={onClose}
              >
                <CloseIcon />
              </button>
              <div className="tg-info-title">{uiText("User Info")}</div>
            </div>
            <div className="tg-info-hero">
              <Avatar id={profileChat?.issueId || profileRef} name={profileName} photo={profilePhoto} hero online={profilePresence?.code === "online"} />
              <div className="tg-info-name">{profileName}</div>
              {profileStatus ? (
                <div className={profileOnlineClass(profilePresence)}>{profileStatus}</div>
              ) : null}
            </div>
            {profileChannel ? (
              <div className="tg-info-block">
                <div className="tg-info-value">{profileChannel}</div>
                <div className="tg-info-label">{uiText("Channel")}</div>
              </div>
            ) : null}
            {profilePhone.startsWith("+") ? (
              <div className="tg-info-block">
                <div className="tg-info-value">{profilePhone}</div>
                <div className="tg-info-label">{uiText("Phone")}</div>
              </div>
            ) : null}
            {profileUser.startsWith("@") ? (
              <div className="tg-info-block">
                <div className="tg-info-value">{profileUser}</div>
                <div className="tg-info-label">{uiText("Username")}</div>
              </div>
            ) : null}
            {profileAbout ? (
              <div className="tg-info-block">
                <div className="tg-info-value">{profileAbout}</div>
                <div className="tg-info-label">{uiText("Bio")}</div>
              </div>
            ) : null}
            {sharedChats > 0 ? (
              <div className="tg-info-block">
                <div className="tg-info-value">{sharedChats}</div>
                <div className="tg-info-label">{uiText("Shared groups")}</div>
              </div>
            ) : null}
            {profileFailed ? (
              <div className="tg-info-block">
                <div className="tg-info-label">{uiText("Something went wrong.")}</div>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}

export function InboxMenu(props: {
  menu: MessageMenuState | null;
  menuPos: { left: number; top: number } | null;
  setMenu: Dispatch<SetStateAction<MessageMenuState | null>>;
  menuMutable: boolean;
  acting: boolean;
  runMenu: (
    op: "react" | "pin" | "unpin" | "delete" | "forward",
    extra: { emoji?: string; revoke?: boolean; targetIssueRef?: string },
  ) => Promise<void>;
  reactions: Record<string, string>;
  chats: TelegramChatRow[];
  setReply: Dispatch<SetStateAction<{ id: string; text: string } | null>>;
  composerRef: RefObject<HTMLTextAreaElement | null>;
  setSelecting: Dispatch<SetStateAction<boolean>>;
  setSelected: Dispatch<SetStateAction<string[]>>;
  copyMessage: (text: string) => Promise<void>;
  menuPinned: boolean;
}) {
  const {
    menu,
    menuPos,
    setMenu,
    menuMutable,
    acting,
    runMenu,
    reactions,
    chats,
    setReply,
    composerRef,
    setSelecting,
    setSelected,
    copyMessage,
    menuPinned,
  } = props;
  return (
    <>
      {menu && menuPos ? (
        <div
          className="tg-menu-scrim"
          onMouseDown={() => setMenu(null)}
          onContextMenu={(event) => {
            event.preventDefault();
            setMenu(null);
          }}
        >
          <div
            className="tg-menu-stack"
            style={{ left: menuPos.left, top: menuPos.top }}
            role="menu"
            onMouseDown={(event) => event.stopPropagation()}
          >
            {menu.page === "menu" || menu.page === "reactions" ? (
              menu.page === "reactions" ? (
                <div className="tg-react-grid">
                  {[...QUICK_REACTIONS, ...MORE_REACTIONS].map((emoji) => (
                    <button key={emoji} type="button" disabled={!menuMutable || acting} onClick={() => void runMenu("react", { emoji: reactions[menu.ids[0] ?? ""] === emoji ? "" : emoji })}>{emoji}</button>
                  ))}
                </div>
              ) : (
                <div className="tg-reacts">
                  {QUICK_REACTIONS.map((emoji) => (
                    <button key={emoji} type="button" disabled={!menuMutable || acting} onClick={() => void runMenu("react", { emoji: reactions[menu.ids[0] ?? ""] === emoji ? "" : emoji })}>{emoji}</button>
                  ))}
                  <button type="button" className="tg-react-more" aria-label={uiText("More reactions")} onClick={() => setMenu({ ...menu, page: "reactions" })}>
                    <MenuIcon d="M6 10l6 6 6-6" />
                  </button>
                </div>
              )
            ) : null}
            <div className="tg-menu">
              {menu.page === "delete" ? (
                <>
                  <button type="button" disabled={!menuMutable || acting} onClick={() => void runMenu("delete", { revoke: false })}>
                    <MenuIcon d="M5 7h14M9 7V5h6v2M8 7l1 12h6l1-12" />
                    {uiText("Delete for me")}
                  </button>
                  <button type="button" className="is-danger" disabled={!menuMutable || acting} onClick={() => void runMenu("delete", { revoke: true })}>
                    <MenuIcon d="M5 7h14M9 7V5h6v2M8 7l1 12h6l1-12" />
                    {uiText("Delete for everyone")}
                  </button>
                </>
              ) : menu.page === "forward" ? (
                <div className="tg-forward-list">
                  {chats.map((chat) => (
                    <button
                      key={chat.issueId}
                      type="button"
                      disabled={!menuMutable || acting}
                      onClick={() => void runMenu("forward", { targetIssueRef: chat.identifier || chat.issueId })}
                    >
                      {chat.label}
                    </button>
                  ))}
                </div>
              ) : (
                <>
                  <button type="button" disabled={menu.ids.length !== 1} onClick={() => {
                    setReply({ id: menu.ids[0] ?? "", text: menu.text.replace(/\s+/g, " ").trim().slice(0, 140) });
                    setMenu(null);
                    composerRef.current?.focus();
                  }}>
                    <MenuIcon d="M9 7 4 12l5 5M4 12h9a6 6 0 0 1 6 6v1" />
                    {uiText("Reply")}
                  </button>
                  {menu.text ? (
                    <button type="button" onClick={() => void copyMessage(menu.text)}>
                      <MenuIcon d="M8 8h10v10H8zM6 6h10v2" />
                      {uiText("Copy")}
                    </button>
                  ) : null}
                  <button type="button" disabled={!menuMutable || menu.ids.length !== 1 || acting} onClick={() => void runMenu(menuPinned ? "unpin" : "pin", {})}>
                    <MenuIcon d="M9 4h6v5l2 2v2H7v-2l2-2zM12 13v7" />
                    {uiText(menuPinned ? "Unpin" : "Pin")}
                  </button>
                  <button type="button" disabled={!menuMutable || acting} onClick={() => setMenu({ ...menu, page: "forward" })}>
                    <MenuIcon d="M15 7l5 5-5 5M20 12H8a5 5 0 0 0-5 5v1" />
                    {uiText("Forward")}
                  </button>
                  <button type="button" disabled={!menuMutable || menu.ids.length !== 1} onClick={() => {
                    const id = menu.ids[0] ?? "";
                    setSelecting(true);
                    setSelected((current) => current.includes(id) ? current : [...current, id]);
                    setMenu(null);
                  }}>
                    <MenuIcon d="M12 3.5a8.5 8.5 0 1 0 .1 0zM8 12.2 10.8 15l5.2-5.4" />
                    {uiText("Select")}
                  </button>
                  <button type="button" className="is-danger" disabled={!menuMutable || acting} onClick={() => setMenu({ ...menu, page: "delete" })}>
                    <MenuIcon d="M5 7h14M9 7V5h6v2M8 7l1 12h6l1-12" />
                    {uiText("Delete")}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
