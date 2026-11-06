/**
 * The app's icon vocabulary. Icons come from lucide-react (ISC license), bundled locally by Vite: nothing loads at runtime.
 * Views import meanings ("copy", "reroll"), not glyph names, so the same action looks the same on every page.
 */
import {
  ArrowRight, AudioWaveform, Ban, Camera, Check, ChevronDown, ChevronRight, CircleCheck, CircleDashed, CircleX, Clapperboard, Clock, CloudLightning, Copy, Cpu,
  Database, Ellipsis, ExternalLink, FileImage, FileText, Film, Folder, FolderOpen, Hourglass, ImageOff, ImagePlus, Images, Info, Layers,
  Link2, ListTree, LoaderCircle, MapPin, Minus, Monitor, Music, Orbit, Palette, Pause, Pencil, Play, Plus, Redo2, RefreshCw, Replace, RotateCcw, Save, Scissors, Settings,
  Shirt, Shuffle, Sparkles, SkipBack, SlidersHorizontal, Square, Terminal, Timer, Trash2, TriangleAlert, User, X, Zap, ZoomIn, ZoomOut, type LucideIcon,
} from "lucide-react";

export const Icon = {
  // Navigation
  projects: Folder, direction: SlidersHorizontal, plan: Clapperboard, locations: MapPin, produce: Play, postprocess: Sparkles, results: Images, settings: Settings,
  // Actions
  add: Plus, save: Save, openFolder: FolderOpen, folder: Folder, copy: Copy, refresh: RefreshCw, check: Check, render: Play, pause: Pause,
  stop: Square, retry: RotateCcw, reroll: Shuffle, external: ExternalLink, next: ArrowRight, remove: Trash2, replace: Replace, more: Ellipsis,
  close: X, minus: Minus, expand: ChevronRight, collapse: ChevronDown, edit: Pencil, zoomIn: ZoomIn, zoomOut: ZoomOut, toStart: SkipBack, redo: Redo2,
  // States
  success: CircleCheck, warning: TriangleAlert, error: CircleX, working: LoaderCircle, queued: Clock, unavailable: Ban, pending: CircleDashed,
  info: Info, log: Terminal, local: Monitor,
  // Things
  song: Music, performer: User, outfit: Shirt, image: FileImage, imageAdd: ImagePlus, imageMissing: ImageOff, film: Film, file: FileText,
  database: Database, gpu: Cpu, elapsed: Timer, remaining: Hourglass, sections: Layers, phases: ListTree, storyWheel: Orbit, look: Palette,
  motif: Zap, event: CloudLightning, timeline: AudioWaveform,
  // Shot joins
  hardCut: Scissors, newAngle: Camera, continueShot: Link2,
} satisfies Record<string, LucideIcon>;

export type { LucideIcon };
