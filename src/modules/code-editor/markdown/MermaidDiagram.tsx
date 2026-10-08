import { type PointerEvent, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Maximize2, RotateCcw } from 'lucide-react';
// Type-only: erased at build time, so it does not pull mermaid into the main chunk.
import type mermaid from 'mermaid';

import { useTheme } from '@/shared/context/ThemeContext';
import { Lightbox } from '@/shared/ui';

// Mermaid is ~1.5MB minified, so it is loaded on demand the first time a
// diagram is rendered and shared by every instance afterwards.
let mermaidPromise: Promise<typeof mermaid> | null = null;
const loadMermaid = () => {
  mermaidPromise ??= import('mermaid').then((module) => module.default);
  return mermaidPromise;
};

// index.html disables browser zoom (user-scalable=no), so the viewer zooms in code.
const MIN_SCALE = 0.25;
const MAX_SCALE = 8;

/** Zoom and pan of the viewer's diagram, applied as translate-then-scale about the screen centre. */
type ViewTransform = { scale: number; x: number; y: number };
type Point = { x: number; y: number };

/** Scale 1 is the diagram fitted to the screen by CSS. */
const FIT: ViewTransform = { scale: 1, x: 0, y: 0 };

/** A client point relative to the centre of `element`, the origin of ViewTransform. */
function fromCentre(element: HTMLElement, clientX: number, clientY: number): Point {
  const rect = element.getBoundingClientRect();
  return { x: clientX - rect.left - rect.width / 2, y: clientY - rect.top - rect.height / 2 };
}

/** Multiplies the scale by `factor`, clamped, keeping the diagram point under `point` in place. */
function zoomAbout(view: ViewTransform, factor: number, point: Point): ViewTransform {
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale * factor));
  const ratio = scale / view.scale;
  return { scale, x: point.x - ratio * (point.x - view.x), y: point.y - ratio * (point.y - view.y) };
}

/**
 * Fullscreen diagram viewer: the diagram first fits the screen; wheel and pinch
 * zoom around the pointer, dragging pans, and the reset button restores the fit.
 */
function MermaidViewer({ svg, onClose }: { svg: string; onClose: () => void }) {
  const { t } = useTranslation('codeEditor');
  // The user's current zoom and pan; it drives the diagram's CSS transform.
  const [view, setView] = useState<ViewTransform>(FIT);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const diagramRef = useRef<HTMLDivElement>(null);
  // Pointers down on the surface, at their last position; two of them make a pinch.
  const pointersRef = useRef(new Map<number, Point>());
  const gestureStartRef = useRef<Point>({ x: 0, y: 0 });
  // Set once a gesture moves, so the click that ends a drag does not close the viewer.
  const draggedRef = useRef(false);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) {
      return;
    }
    // A native, non-passive listener: React's wheel listener is passive, and
    // without preventDefault the page behind scrolls or a trackpad pinch zooms it.
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      const point = fromCentre(surface, event.clientX, event.clientY);
      setView((current) => zoomAbout(current, Math.exp(-event.deltaY * 0.002), point));
    };
    surface.addEventListener('wheel', handleWheel, { passive: false });
    return () => surface.removeEventListener('wheel', handleWheel);
  }, []);

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (pointersRef.current.size === 0) {
      gestureStartRef.current = { x: event.clientX, y: event.clientY };
      draggedRef.current = false;
    }
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const pointers = pointersRef.current;
    const previous = pointers.get(event.pointerId);
    if (!previous) {
      return;
    }
    const next = { x: event.clientX, y: event.clientY };
    pointers.set(event.pointerId, next);
    const start = gestureStartRef.current;
    // A few pixels of jitter still count as a click.
    if (Math.hypot(next.x - start.x, next.y - start.y) > 4) {
      draggedRef.current = true;
    }

    if (pointers.size === 1) {
      setView((current) => ({ ...current, x: current.x + next.x - previous.x, y: current.y + next.y - previous.y }));
      return;
    }
    const other = [...pointers].find(([id]) => id !== event.pointerId)?.[1];
    const before = other && Math.hypot(previous.x - other.x, previous.y - other.y);
    if (!other || !before || !surfaceRef.current) {
      return;
    }
    // Pinch: zoom about the old midpoint by the change in finger distance, then
    // follow the midpoint as it moves.
    const after = Math.hypot(next.x - other.x, next.y - other.y);
    const midpoint = fromCentre(surfaceRef.current, (previous.x + other.x) / 2, (previous.y + other.y) / 2);
    const shift = { x: (next.x - previous.x) / 2, y: (next.y - previous.y) / 2 };
    setView((current) => {
      const zoomed = zoomAbout(current, after / before, midpoint);
      return { ...zoomed, x: zoomed.x + shift.x, y: zoomed.y + shift.y };
    });
  };

  const releasePointer = (event: PointerEvent<HTMLDivElement>) => {
    pointersRef.current.delete(event.pointerId);
  };

  return (
    <Lightbox label={t('mermaid.viewer')} closeLabel={t('mermaid.close')} onClose={onClose}>
      <div
        ref={surfaceRef}
        className="absolute inset-0 flex cursor-grab touch-none select-none items-center justify-center overflow-hidden active:cursor-grabbing"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={releasePointer}
        onPointerCancel={releasePointer}
        onPointerLeave={releasePointer}
        onClick={(event) => {
          // Only a plain click outside the diagram reaches the backdrop and closes.
          if (draggedRef.current || diagramRef.current?.contains(event.target as Node)) {
            event.stopPropagation();
          }
        }}
      >
        <div
          ref={diagramRef}
          className="h-[90vh] w-[92vw] rounded-lg bg-white p-4 shadow-2xl dark:bg-zinc-900 [&_svg]:h-full [&_svg]:w-full [&_svg]:!max-w-none"
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          setView(FIT);
        }}
        aria-label={t('mermaid.resetZoom')}
        className="absolute right-16 top-4 rounded-full bg-white/10 p-2 text-white transition-colors hover:bg-white/20"
      >
        <RotateCcw className="h-5 w-5" />
      </button>
    </Lightbox>
  );
}

type MermaidDiagramProps = {
  /** Raw mermaid source, i.e. the body of a ```mermaid fenced block. */
  code: string;
};

/**
 * Renders a ```mermaid code block as an SVG diagram, GitHub-preview style.
 *
 * Used by the chat module to render mermaid blocks in assistant messages, and
 * by MarkdownCodeBlock inside code-editor for markdown previews.
 *
 * While mermaid is loading — or when the source doesn't parse (e.g. a block
 * that is still streaming in) — the raw source is shown instead, so the
 * content is never blank or replaced by an error box.
 *
 * A rendered diagram opens a fullscreen zoomable viewer on click or through
 * its expand button, which shows on hover where the device can hover.
 */
export default function MermaidDiagram({ code }: MermaidDiagramProps) {
  const { isDarkMode } = useTheme();
  const reactId = useId();
  const [svg, setSvg] = useState<string | null>(null);
  // Whether the fullscreen viewer is open over the page.
  const [viewerOpen, setViewerOpen] = useState(false);
  const { t } = useTranslation('codeEditor');

  useEffect(() => {
    let cancelled = false;
    const renderId = `mermaid-${reactId.replace(/[^a-zA-Z0-9]/g, '')}`;

    loadMermaid()
      .then((mermaid) => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: isDarkMode ? 'dark' : 'default',
          suppressErrorRendering: true,
        });
        return mermaid.render(renderId, code.trim());
      })
      .then((result) => {
        if (!cancelled) {
          setSvg(result.svg);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSvg(null);
        }
        // suppressErrorRendering still leaves the scratch element behind on
        // parse failures in some mermaid versions; clean it up.
        document.getElementById(`d${renderId}`)?.remove();
      });

    return () => {
      cancelled = true;
    };
  }, [code, isDarkMode, reactId]);

  if (!svg) {
    return (
      <pre className="my-3 overflow-x-auto rounded-xl border border-border bg-muted/50 p-4 font-mono text-[0.8125rem] leading-relaxed text-muted-foreground dark:bg-zinc-900">
        {code.trim()}
      </pre>
    );
  }

  return (
    <div className="group relative my-3">
      <div
        onClick={() => setViewerOpen(true)}
        className="flex cursor-zoom-in justify-center overflow-x-auto rounded-xl border border-border bg-white p-4 dark:bg-zinc-900 [&_svg]:h-auto [&_svg]:max-w-full"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      <button
        type="button"
        onClick={() => setViewerOpen(true)}
        aria-label={t('mermaid.expand')}
        className="absolute right-2 top-2 rounded-md border border-border bg-background/80 p-1.5 text-muted-foreground transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:hover)]:opacity-0"
      >
        <Maximize2 className="h-4 w-4" />
      </button>
      {viewerOpen && <MermaidViewer svg={svg} onClose={() => setViewerOpen(false)} />}
    </div>
  );
}
