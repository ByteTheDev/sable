import type { ToolKind } from '@shared/protocol';
import { ArrowBendDownRightIcon } from '@phosphor-icons/react/dist/csr/ArrowBendDownRight';
import { ArrowDownIcon } from '@phosphor-icons/react/dist/csr/ArrowDown';
import { ArrowSquareOutIcon } from '@phosphor-icons/react/dist/csr/ArrowSquareOut';
import { ArrowUpIcon } from '@phosphor-icons/react/dist/csr/ArrowUp';
import { BrainIcon } from '@phosphor-icons/react/dist/csr/Brain';
import { CameraIcon } from '@phosphor-icons/react/dist/csr/Camera';
import { CaretDownIcon } from '@phosphor-icons/react/dist/csr/CaretDown';
import { CaretLeftIcon } from '@phosphor-icons/react/dist/csr/CaretLeft';
import { CaretRightIcon } from '@phosphor-icons/react/dist/csr/CaretRight';
import { CheckIcon } from '@phosphor-icons/react/dist/csr/Check';
import { ClipboardTextIcon } from '@phosphor-icons/react/dist/csr/ClipboardText';
import { CubeIcon } from '@phosphor-icons/react/dist/csr/Cube';
import { DesktopIcon } from '@phosphor-icons/react/dist/csr/Desktop';
import { DeviceMobileIcon } from '@phosphor-icons/react/dist/csr/DeviceMobile';
import { FileTextIcon } from '@phosphor-icons/react/dist/csr/FileText';
import { FlowArrowIcon } from '@phosphor-icons/react/dist/csr/FlowArrow';
import { FolderSimpleIcon } from '@phosphor-icons/react/dist/csr/FolderSimple';
import { GaugeIcon } from '@phosphor-icons/react/dist/csr/Gauge';
import { GearIcon } from '@phosphor-icons/react/dist/csr/Gear';
import { GlobeIcon } from '@phosphor-icons/react/dist/csr/Globe';
import { HandPalmIcon } from '@phosphor-icons/react/dist/csr/HandPalm';
import { ImageIcon } from '@phosphor-icons/react/dist/csr/Image';
import { LightningIcon } from '@phosphor-icons/react/dist/csr/Lightning';
import { LinkIcon } from '@phosphor-icons/react/dist/csr/Link';
import { ListChecksIcon } from '@phosphor-icons/react/dist/csr/ListChecks';
import { MagnifyingGlassIcon } from '@phosphor-icons/react/dist/csr/MagnifyingGlass';
import { MapTrifoldIcon } from '@phosphor-icons/react/dist/csr/MapTrifold';
import { PaperclipIcon } from '@phosphor-icons/react/dist/csr/Paperclip';
import { PencilSimpleIcon } from '@phosphor-icons/react/dist/csr/PencilSimple';
import { PlugsIcon } from '@phosphor-icons/react/dist/csr/Plugs';
import { PlusIcon } from '@phosphor-icons/react/dist/csr/Plus';
import { QrCodeIcon } from '@phosphor-icons/react/dist/csr/QrCode';
import { QuestionIcon } from '@phosphor-icons/react/dist/csr/Question';
import { ShieldCheckIcon } from '@phosphor-icons/react/dist/csr/ShieldCheck';
import { ShieldIcon } from '@phosphor-icons/react/dist/csr/Shield';
import { SparkleIcon } from '@phosphor-icons/react/dist/csr/Sparkle';
import { TerminalIcon } from '@phosphor-icons/react/dist/csr/Terminal';
import { TrashIcon } from '@phosphor-icons/react/dist/csr/Trash';
import { TreeStructureIcon } from '@phosphor-icons/react/dist/csr/TreeStructure';
import { WarningCircleIcon } from '@phosphor-icons/react/dist/csr/WarningCircle';
import { WifiSlashIcon } from '@phosphor-icons/react/dist/csr/WifiSlash';
import { WrenchIcon } from '@phosphor-icons/react/dist/csr/Wrench';
import { XIcon } from '@phosphor-icons/react/dist/csr/X';
import { BellIcon } from '@phosphor-icons/react/dist/csr/Bell';
import { NotePencilIcon } from '@phosphor-icons/react/dist/csr/NotePencil';
import { EyeIcon } from '@phosphor-icons/react/dist/csr/Eye';
import { PushPinIcon } from '@phosphor-icons/react/dist/csr/PushPin';
import { ArchiveIcon } from '@phosphor-icons/react/dist/csr/Archive';

const ICONS = {
  up: ArrowUpIcon,
  down: ArrowDownIcon,
  steer: ArrowBendDownRightIcon,
  external: ArrowSquareOutIcon,
  brain: BrainIcon,
  camera: CameraIcon,
  caretDown: CaretDownIcon,
  back: CaretLeftIcon,
  next: CaretRightIcon,
  check: CheckIcon,
  clipboard: ClipboardTextIcon,
  cube: CubeIcon,
  desktop: DesktopIcon,
  phone: DeviceMobileIcon,
  file: FileTextIcon,
  workflow: FlowArrowIcon,
  folder: FolderSimpleIcon,
  gauge: GaugeIcon,
  gear: GearIcon,
  globe: GlobeIcon,
  hand: HandPalmIcon,
  image: ImageIcon,
  bolt: LightningIcon,
  link: LinkIcon,
  todo: ListChecksIcon,
  search: MagnifyingGlassIcon,
  plan: MapTrifoldIcon,
  clip: PaperclipIcon,
  edit: PencilSimpleIcon,
  write: NotePencilIcon,
  mcp: PlugsIcon,
  plus: PlusIcon,
  qr: QrCodeIcon,
  question: QuestionIcon,
  shieldCheck: ShieldCheckIcon,
  shield: ShieldIcon,
  sparkle: SparkleIcon,
  terminal: TerminalIcon,
  trash: TrashIcon,
  agent: TreeStructureIcon,
  warning: WarningCircleIcon,
  offline: WifiSlashIcon,
  tool: WrenchIcon,
  x: XIcon,
  bell: BellIcon,
  eye: EyeIcon,
  pin: PushPinIcon,
  archive: ArchiveIcon,
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 18, weight = 'regular', className }: { name: IconName; size?: number; weight?: 'regular' | 'bold' | 'fill'; className?: string }) {
  const C = ICONS[name];
  return <C size={size} weight={weight} className={className} aria-hidden />;
}

export const TOOL_ICON: Record<ToolKind, IconName> = {
  bash: 'terminal',
  read: 'file',
  edit: 'edit',
  write: 'write',
  search: 'search',
  glob: 'search',
  fetch: 'globe',
  websearch: 'globe',
  agent: 'agent',
  todo: 'todo',
  mcp: 'mcp',
  question: 'question',
  plan: 'plan',
  skill: 'sparkle',
  widget: 'cube',
  browser: 'globe',
  device: 'phone',
  other: 'tool',
};
