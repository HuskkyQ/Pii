import { Menu, Pencil } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ConnectionState, Snapshot } from "@/lib/types";
import { cn } from "@/lib/utils";

import { PushToggle } from "./PushToggle";

/** 只保留「多少 token / 花了多少」，模型名交给窄屏外的位置显示，避免移动端挤爆。 */
function formatUsage(snapshot: Snapshot | null): string {
  const models = snapshot?.usage?.models;
  if (!models) return "";
  const entries = Object.values(models);
  if (entries.length === 0) return "";
  const usage = entries[entries.length - 1];
  const tokens = usage.totalTokens ?? (usage.input ?? 0) + (usage.output ?? 0);
  const cost = usage.cost?.total;
  return [tokens ? `${tokens.toLocaleString()} tok` : null, cost ? `$${cost.toFixed(4)}` : null]
    .filter(Boolean)
    .join(" · ");
}

const LABEL: Record<ConnectionState, string> = {
  connecting: "连接中…",
  open: "已连接",
  closed: "断开，重连中…",
};

interface StatusBarProps {
  connection: ConnectionState;
  snapshot: Snapshot | null;
  /** 当前会话标题（没有就显示 pii） */
  title: string;
  onOpenMenu: () => void;
  /** 点了标题改名时调用；不传就不开启改名 */
  onRename?: (title: string) => Promise<void>;
  /** 通知开关要记住当前会话，订阅时带上 */
  conversationId?: number;
}

export function StatusBar({ connection, snapshot, title, onOpenMenu, onRename, conversationId }: StatusBarProps) {
  const model = snapshot?.agent?.model;
  const usage = formatUsage(snapshot);

  // 行内改名：点标题 → 变成输入框 → 回车/失焦保存、Esc 取消。
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  // 防抖：回车和失焦都会触发保存，用一个标志位避免重复提交
  const finishedRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) return;
    const el = inputRef.current;
    el?.focus();
    el?.select();
  }, [editing]);

  const startEdit = () => {
    if (!onRename) return;
    finishedRef.current = false;
    setDraft(title);
    setEditing(true);
  };

  const cancel = () => {
    finishedRef.current = true;
    setEditing(false);
  };

  const commit = async () => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    const next = draft.replace(/\s+/g, " ").trim();
    if (!next || next === title) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await onRename?.(next);
      setEditing(false);
    } catch {
      // 失败保留编辑态、允许重试（错误提示由调用方负责）
      finishedRef.current = false;
    } finally {
      setSaving(false);
    }
  };

  return (
    <header className="flex shrink-0 items-center gap-2 overflow-hidden border-b px-2 py-2 sm:px-3 sm:py-2.5">
      {/* 手机上唯一的入口：会话抽屉 */}
      <Button
        size="icon"
        variant="ghost"
        className="size-8 shrink-0 md:hidden"
        onClick={onOpenMenu}
        aria-label="会话列表"
      >
        <Menu className="size-4" />
      </Button>

      <span
        className={cn(
          "size-2 shrink-0 rounded-full",
          connection === "open" ? "bg-emerald-500" : connection === "connecting" ? "bg-amber-500" : "bg-destructive",
        )}
        aria-hidden
      />

      {/* 标题占走中间的弹性空间，长标题用省略号，不让状态栏折行。点一下可以改名。 */}
      {editing ? (
        <Input
          ref={inputRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void commit();
            } else if (event.key === "Escape") {
              event.preventDefault();
              cancel();
            }
          }}
          onBlur={() => void commit()}
          disabled={saving}
          maxLength={100}
          aria-label="会话名称"
          className="h-7 min-w-0 flex-1 px-1.5 py-0.5 text-[13px] font-medium"
        />
      ) : (
        <button
          type="button"
          onClick={startEdit}
          disabled={!onRename}
          title={onRename ? "点击重命名" : undefined}
          aria-label={onRename ? `重命名会话：${title}` : undefined}
          className={cn(
            "group/title flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 py-0.5 text-left transition-colors",
            onRename ? "hover:bg-accent/60" : "cursor-default",
          )}
        >
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{title}</span>
          {onRename && (
            <Pencil
              className="size-3 shrink-0 text-muted-foreground/40 opacity-0 transition-opacity group-hover/title:opacity-100"
              aria-hidden
            />
          )}
        </button>
      )}

      {/*
       * 已连接时文字是多余的（绿点就够了），窄屏藏起来。
       * 但「连接中 / 断开」必须看得见 —— 否则用户只看到一个黄点，
       * 不知道现在不能发消息。所以非 open 状态在手机上也要显示文字。
       */}
      <span
        className={cn(
          "shrink-0 whitespace-nowrap text-[12.5px]",
          connection === "open" ? "hidden text-muted-foreground sm:inline" : "inline",
          connection === "connecting" ? "text-amber-400" : connection === "closed" ? "text-destructive" : "",
        )}
      >
        {LABEL[connection]}
      </span>

      <span className="hidden min-w-0 max-w-[38%] shrink-0 truncate font-mono text-[12px] text-muted-foreground/70 lg:block">
        {model ? `${model.provider}/${model.modelId}` : ""}
      </span>

      <span className="shrink-0 whitespace-nowrap font-mono text-[11.5px] text-muted-foreground/60">
        {usage}
      </span>

      <PushToggle conversationId={conversationId} />
    </header>
  );
}
