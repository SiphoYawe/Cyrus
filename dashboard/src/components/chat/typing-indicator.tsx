'use client';

export function TypingIndicator() {
  return (
    <div className="flex items-center gap-1 px-1 py-0.5" aria-label="CYRUS is typing">
      <span className="h-2 w-2 rounded-full bg-violet-500 animate-bounce-dot-1" />
      <span className="h-2 w-2 rounded-full bg-violet-500 animate-bounce-dot-2" />
      <span className="h-2 w-2 rounded-full bg-violet-500 animate-bounce-dot-3" />
    </div>
  );
}
