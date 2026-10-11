import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef } from "react";
import { panelClass } from "./styles";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Open modals, innermost last; only the topmost one keeps focus inside itself.
const openModals: HTMLElement[] = [];

/** Modal dialog: focuses its first field, keeps Tab inside, closes on Escape, restores focus. */
export function ModalDialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    (dialog?.querySelector<HTMLElement>(FOCUSABLE) ?? dialog)?.focus();
    // Focus that lands outside (a backdrop click, a programmatic move) is pulled back, so Tab
    // handling below always starts inside the dialog.
    if (dialog) {
      openModals.push(dialog);
    }
    const keepFocusInside = (event: FocusEvent) => {
      if (
        dialog &&
        openModals[openModals.length - 1] === dialog &&
        event.target instanceof Node &&
        !dialog.contains(event.target)
      ) {
        dialog.focus();
      }
    };
    document.addEventListener("focusin", keepFocusInside);
    return () => {
      document.removeEventListener("focusin", keepFocusInside);
      const index = dialog ? openModals.lastIndexOf(dialog) : -1;
      if (index >= 0) {
        openModals.splice(index, 1);
      }
      if (opener?.isConnected) {
        opener.focus();
      }
    };
  }, []);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab" || !dialogRef.current) {
      return;
    }
    const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) {
      event.preventDefault();
    } else if (document.activeElement === dialogRef.current) {
      // Focus was pulled back to the container, which is not in the tab order.
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-[#17201b]/40 p-4"
      // A backdrop press would otherwise move focus to the page behind the modal.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          event.preventDefault();
          dialogRef.current?.focus();
        }
      }}
    >
      <div
        ref={dialogRef}
        className={`${panelClass} w-full max-w-md p-5 shadow-lg`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <h2 id={titleId} className="m-0 mb-3 text-xl font-semibold">
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}
