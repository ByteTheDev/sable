import type { CSSProperties } from 'react';
import type { Icon as PhIcon, IconWeight } from '@phosphor-icons/react';
import { PlusIcon } from '@phosphor-icons/react/dist/csr/Plus';
import { MinusIcon } from '@phosphor-icons/react/dist/csr/Minus';
import { MagnifyingGlassIcon } from '@phosphor-icons/react/dist/csr/MagnifyingGlass';
import { GearSixIcon } from '@phosphor-icons/react/dist/csr/GearSix';
import { SidebarSimpleIcon } from '@phosphor-icons/react/dist/csr/SidebarSimple';
import { HouseIcon } from '@phosphor-icons/react/dist/csr/House';
import { FolderIcon } from '@phosphor-icons/react/dist/csr/Folder';
import { FolderOpenIcon } from '@phosphor-icons/react/dist/csr/FolderOpen';
import { FolderSimplePlusIcon } from '@phosphor-icons/react/dist/csr/FolderSimplePlus';
import { FileIcon } from '@phosphor-icons/react/dist/csr/File';
import { FileCodeIcon } from '@phosphor-icons/react/dist/csr/FileCode';
import { FileTextIcon } from '@phosphor-icons/react/dist/csr/FileText';
import { FilePlusIcon } from '@phosphor-icons/react/dist/csr/FilePlus';
import { FileMagnifyingGlassIcon } from '@phosphor-icons/react/dist/csr/FileMagnifyingGlass';
import { ImageSquareIcon } from '@phosphor-icons/react/dist/csr/ImageSquare';
import { GitBranchIcon } from '@phosphor-icons/react/dist/csr/GitBranch';
import { GitCommitIcon } from '@phosphor-icons/react/dist/csr/GitCommit';
import { GitDiffIcon } from '@phosphor-icons/react/dist/csr/GitDiff';
import { GitForkIcon } from '@phosphor-icons/react/dist/csr/GitFork';
import { GitPullRequestIcon } from '@phosphor-icons/react/dist/csr/GitPullRequest';
import { TerminalWindowIcon } from '@phosphor-icons/react/dist/csr/TerminalWindow';
import { TerminalIcon } from '@phosphor-icons/react/dist/csr/Terminal';
import { ListChecksIcon } from '@phosphor-icons/react/dist/csr/ListChecks';
import { ChartDonutIcon } from '@phosphor-icons/react/dist/csr/ChartDonut';
import { GaugeIcon } from '@phosphor-icons/react/dist/csr/Gauge';
import { ClockCounterClockwiseIcon } from '@phosphor-icons/react/dist/csr/ClockCounterClockwise';
import { ChatCircleIcon } from '@phosphor-icons/react/dist/csr/ChatCircle';
import { ChatsCircleIcon } from '@phosphor-icons/react/dist/csr/ChatsCircle';
import { SparkleIcon } from '@phosphor-icons/react/dist/csr/Sparkle';
import { LightningIcon } from '@phosphor-icons/react/dist/csr/Lightning';
import { BrainIcon } from '@phosphor-icons/react/dist/csr/Brain';
import { EyeIcon } from '@phosphor-icons/react/dist/csr/Eye';
import { PencilSimpleIcon } from '@phosphor-icons/react/dist/csr/PencilSimple';
import { NotePencilIcon } from '@phosphor-icons/react/dist/csr/NotePencil';
import { TrashIcon } from '@phosphor-icons/react/dist/csr/Trash';
import { CopyIcon } from '@phosphor-icons/react/dist/csr/Copy';
import { CheckIcon } from '@phosphor-icons/react/dist/csr/Check';
import { ChecksIcon } from '@phosphor-icons/react/dist/csr/Checks';
import { XIcon } from '@phosphor-icons/react/dist/csr/X';
import { CaretDownIcon } from '@phosphor-icons/react/dist/csr/CaretDown';
import { CaretRightIcon } from '@phosphor-icons/react/dist/csr/CaretRight';
import { CaretLeftIcon } from '@phosphor-icons/react/dist/csr/CaretLeft';
import { CaretUpIcon } from '@phosphor-icons/react/dist/csr/CaretUp';
import { CaretUpDownIcon } from '@phosphor-icons/react/dist/csr/CaretUpDown';
import { ArrowUpIcon } from '@phosphor-icons/react/dist/csr/ArrowUp';
import { ArrowDownIcon } from '@phosphor-icons/react/dist/csr/ArrowDown';
import { ArrowRightIcon } from '@phosphor-icons/react/dist/csr/ArrowRight';
import { ArrowLeftIcon } from '@phosphor-icons/react/dist/csr/ArrowLeft';
import { ArrowLineDownIcon } from '@phosphor-icons/react/dist/csr/ArrowLineDown';
import { StopIcon } from '@phosphor-icons/react/dist/csr/Stop';
import { PlayIcon } from '@phosphor-icons/react/dist/csr/Play';
import { PauseIcon } from '@phosphor-icons/react/dist/csr/Pause';
import { PaperclipIcon } from '@phosphor-icons/react/dist/csr/Paperclip';
import { MicrophoneIcon } from '@phosphor-icons/react/dist/csr/Microphone';
import { AtIcon } from '@phosphor-icons/react/dist/csr/At';
import { HashIcon } from '@phosphor-icons/react/dist/csr/Hash';
import { CurrencyDollarIcon } from '@phosphor-icons/react/dist/csr/CurrencyDollar';
import { GlobeIcon } from '@phosphor-icons/react/dist/csr/Globe';
import { LinkIcon } from '@phosphor-icons/react/dist/csr/Link';
import { DownloadSimpleIcon } from '@phosphor-icons/react/dist/csr/DownloadSimple';
import { LockIcon } from '@phosphor-icons/react/dist/csr/Lock';
import { LockOpenIcon } from '@phosphor-icons/react/dist/csr/LockOpen';
import { ShieldCheckIcon } from '@phosphor-icons/react/dist/csr/ShieldCheck';
import { ShieldWarningIcon } from '@phosphor-icons/react/dist/csr/ShieldWarning';
import { WarningIcon } from '@phosphor-icons/react/dist/csr/Warning';
import { WarningCircleIcon } from '@phosphor-icons/react/dist/csr/WarningCircle';
import { InfoIcon } from '@phosphor-icons/react/dist/csr/Info';
import { QuestionIcon } from '@phosphor-icons/react/dist/csr/Question';
import { RobotIcon } from '@phosphor-icons/react/dist/csr/Robot';
import { UsersThreeIcon } from '@phosphor-icons/react/dist/csr/UsersThree';
import { PlugsConnectedIcon } from '@phosphor-icons/react/dist/csr/PlugsConnected';
import { PlugsIcon } from '@phosphor-icons/react/dist/csr/Plugs';
import { PuzzlePieceIcon } from '@phosphor-icons/react/dist/csr/PuzzlePiece';
import { BookOpenIcon } from '@phosphor-icons/react/dist/csr/BookOpen';
import { KeyboardIcon } from '@phosphor-icons/react/dist/csr/Keyboard';
import { PaletteIcon } from '@phosphor-icons/react/dist/csr/Palette';
import { SlidersHorizontalIcon } from '@phosphor-icons/react/dist/csr/SlidersHorizontal';
import { BellIcon } from '@phosphor-icons/react/dist/csr/Bell';
import { PushPinIcon } from '@phosphor-icons/react/dist/csr/PushPin';
import { PushPinSlashIcon } from '@phosphor-icons/react/dist/csr/PushPinSlash';
import { ArchiveIcon } from '@phosphor-icons/react/dist/csr/Archive';
import { DotsThreeIcon } from '@phosphor-icons/react/dist/csr/DotsThree';
import { DotsThreeVerticalIcon } from '@phosphor-icons/react/dist/csr/DotsThreeVertical';
import { ArrowsClockwiseIcon } from '@phosphor-icons/react/dist/csr/ArrowsClockwise';
import { ArrowCounterClockwiseIcon } from '@phosphor-icons/react/dist/csr/ArrowCounterClockwise';
import { SignOutIcon } from '@phosphor-icons/react/dist/csr/SignOut';
import { SignInIcon } from '@phosphor-icons/react/dist/csr/SignIn';
import { UserCircleIcon } from '@phosphor-icons/react/dist/csr/UserCircle';
import { CubeIcon } from '@phosphor-icons/react/dist/csr/Cube';
import { StackIcon } from '@phosphor-icons/react/dist/csr/Stack';
import { ListIcon } from '@phosphor-icons/react/dist/csr/List';
import { SquaresFourIcon } from '@phosphor-icons/react/dist/csr/SquaresFour';
import { CommandIcon } from '@phosphor-icons/react/dist/csr/Command';
import { ArrowElbowDownLeftIcon } from '@phosphor-icons/react/dist/csr/ArrowElbowDownLeft';
import { ArrowsOutSimpleIcon } from '@phosphor-icons/react/dist/csr/ArrowsOutSimple';
import { ArrowsInSimpleIcon } from '@phosphor-icons/react/dist/csr/ArrowsInSimple';
import { ArrowSquareOutIcon } from '@phosphor-icons/react/dist/csr/ArrowSquareOut';
import { FunnelSimpleIcon } from '@phosphor-icons/react/dist/csr/FunnelSimple';
import { StarIcon } from '@phosphor-icons/react/dist/csr/Star';
import { WrenchIcon } from '@phosphor-icons/react/dist/csr/Wrench';
import { CodeIcon } from '@phosphor-icons/react/dist/csr/Code';
import { BracketsCurlyIcon } from '@phosphor-icons/react/dist/csr/BracketsCurly';
import { DatabaseIcon } from '@phosphor-icons/react/dist/csr/Database';
import { CloudIcon } from '@phosphor-icons/react/dist/csr/Cloud';
import { LaptopIcon } from '@phosphor-icons/react/dist/csr/Laptop';
import { TreeStructureIcon } from '@phosphor-icons/react/dist/csr/TreeStructure';
import { CompassIcon } from '@phosphor-icons/react/dist/csr/Compass';
import { QueueIcon } from '@phosphor-icons/react/dist/csr/Queue';
import { TimerIcon } from '@phosphor-icons/react/dist/csr/Timer';
import { CoinsIcon } from '@phosphor-icons/react/dist/csr/Coins';
import { MagicWandIcon } from '@phosphor-icons/react/dist/csr/MagicWand';
import { HandPalmIcon } from '@phosphor-icons/react/dist/csr/HandPalm';
import { FastForwardIcon } from '@phosphor-icons/react/dist/csr/FastForward';
import { FireIcon } from '@phosphor-icons/react/dist/csr/Fire';
import { CheckCircleIcon } from '@phosphor-icons/react/dist/csr/CheckCircle';
import { XCircleIcon } from '@phosphor-icons/react/dist/csr/XCircle';
import { CircleIcon } from '@phosphor-icons/react/dist/csr/Circle';
import { CircleDashedIcon } from '@phosphor-icons/react/dist/csr/CircleDashed';
import { ProhibitIcon } from '@phosphor-icons/react/dist/csr/Prohibit';
import { LightbulbIcon } from '@phosphor-icons/react/dist/csr/Lightbulb';
import { BroomIcon } from '@phosphor-icons/react/dist/csr/Broom';
import { ArrowBendUpLeftIcon } from '@phosphor-icons/react/dist/csr/ArrowBendUpLeft';
import { ExportIcon } from '@phosphor-icons/react/dist/csr/Export';
import { HardDrivesIcon } from '@phosphor-icons/react/dist/csr/HardDrives';
import { KeyIcon } from '@phosphor-icons/react/dist/csr/Key';
import { PulseIcon } from '@phosphor-icons/react/dist/csr/Pulse';
import { ClipboardTextIcon } from '@phosphor-icons/react/dist/csr/ClipboardText';
import { PackageIcon } from '@phosphor-icons/react/dist/csr/Package';
import { BugIcon } from '@phosphor-icons/react/dist/csr/Bug';
import { FlaskIcon } from '@phosphor-icons/react/dist/csr/Flask';
import { RocketIcon } from '@phosphor-icons/react/dist/csr/Rocket';
import { ListBulletsIcon } from '@phosphor-icons/react/dist/csr/ListBullets';
import { TextAlignLeftIcon } from '@phosphor-icons/react/dist/csr/TextAlignLeft';
import { BrowserIcon } from '@phosphor-icons/react/dist/csr/Browser';
import { TargetIcon } from '@phosphor-icons/react/dist/csr/Target';
import { PathIcon } from '@phosphor-icons/react/dist/csr/Path';
import { HourglassIcon } from '@phosphor-icons/react/dist/csr/Hourglass';
import { SwatchesIcon } from '@phosphor-icons/react/dist/csr/Swatches';
import { MoonStarsIcon } from '@phosphor-icons/react/dist/csr/MoonStars';
import { TagIcon } from '@phosphor-icons/react/dist/csr/Tag';
import { WebhooksLogoIcon } from '@phosphor-icons/react/dist/csr/WebhooksLogo';
import { DevicesIcon } from '@phosphor-icons/react/dist/csr/Devices';
import { CursorClickIcon } from '@phosphor-icons/react/dist/csr/CursorClick';
import './icons.css';

/** One icon vocabulary for the whole app. Names describe meaning, not the glyph. */
const ICONS = {
  plus: PlusIcon,
  minus: MinusIcon,
  search: MagnifyingGlassIcon,
  settings: GearSixIcon,
  sidebar: SidebarSimpleIcon,
  home: HouseIcon,
  folder: FolderIcon,
  'folder-open': FolderOpenIcon,
  'folder-plus': FolderSimplePlusIcon,
  file: FileIcon,
  'file-code': FileCodeIcon,
  'file-text': FileTextIcon,
  'file-plus': FilePlusIcon,
  'file-search': FileMagnifyingGlassIcon,
  image: ImageSquareIcon,
  branch: GitBranchIcon,
  commit: GitCommitIcon,
  diff: GitDiffIcon,
  fork: GitForkIcon,
  'pull-request': GitPullRequestIcon,
  terminal: TerminalWindowIcon,
  prompt: TerminalIcon,
  tasks: ListChecksIcon,
  context: ChartDonutIcon,
  gauge: GaugeIcon,
  history: ClockCounterClockwiseIcon,
  chat: ChatCircleIcon,
  chats: ChatsCircleIcon,
  sparkle: SparkleIcon,
  bolt: LightningIcon,
  brain: BrainIcon,
  eye: EyeIcon,
  pencil: PencilSimpleIcon,
  compose: NotePencilIcon,
  trash: TrashIcon,
  copy: CopyIcon,
  check: CheckIcon,
  checks: ChecksIcon,
  x: XIcon,
  'caret-down': CaretDownIcon,
  'caret-right': CaretRightIcon,
  'caret-left': CaretLeftIcon,
  'caret-up': CaretUpIcon,
  'caret-updown': CaretUpDownIcon,
  'arrow-up': ArrowUpIcon,
  'arrow-down': ArrowDownIcon,
  'arrow-right': ArrowRightIcon,
  'arrow-left': ArrowLeftIcon,
  'to-bottom': ArrowLineDownIcon,
  stop: StopIcon,
  play: PlayIcon,
  pause: PauseIcon,
  attach: PaperclipIcon,
  mic: MicrophoneIcon,
  at: AtIcon,
  hash: HashIcon,
  dollar: CurrencyDollarIcon,
  globe: GlobeIcon,
  link: LinkIcon,
  download: DownloadSimpleIcon,
  lock: LockIcon,
  unlock: LockOpenIcon,
  shield: ShieldCheckIcon,
  'shield-warning': ShieldWarningIcon,
  warning: WarningIcon,
  error: WarningCircleIcon,
  info: InfoIcon,
  question: QuestionIcon,
  robot: RobotIcon,
  agents: UsersThreeIcon,
  mcp: PlugsConnectedIcon,
  plug: PlugsIcon,
  skill: PuzzlePieceIcon,
  memory: BookOpenIcon,
  keyboard: KeyboardIcon,
  palette: PaletteIcon,
  sliders: SlidersHorizontalIcon,
  bell: BellIcon,
  pin: PushPinIcon,
  'pin-off': PushPinSlashIcon,
  archive: ArchiveIcon,
  dots: DotsThreeIcon,
  'dots-vertical': DotsThreeVerticalIcon,
  refresh: ArrowsClockwiseIcon,
  rewind: ArrowCounterClockwiseIcon,
  'sign-out': SignOutIcon,
  'sign-in': SignInIcon,
  user: UserCircleIcon,
  cube: CubeIcon,
  stack: StackIcon,
  list: ListIcon,
  grid: SquaresFourIcon,
  command: CommandIcon,
  enter: ArrowElbowDownLeftIcon,
  expand: ArrowsOutSimpleIcon,
  collapse: ArrowsInSimpleIcon,
  external: ArrowSquareOutIcon,
  filter: FunnelSimpleIcon,
  star: StarIcon,
  wrench: WrenchIcon,
  code: CodeIcon,
  braces: BracketsCurlyIcon,
  database: DatabaseIcon,
  cloud: CloudIcon,
  laptop: LaptopIcon,
  tree: TreeStructureIcon,
  compass: CompassIcon,
  queue: QueueIcon,
  timer: TimerIcon,
  coins: CoinsIcon,
  wand: MagicWandIcon,
  hand: HandPalmIcon,
  'fast-forward': FastForwardIcon,
  fire: FireIcon,
  'check-circle': CheckCircleIcon,
  'x-circle': XCircleIcon,
  circle: CircleIcon,
  'circle-dashed': CircleDashedIcon,
  prohibit: ProhibitIcon,
  lightbulb: LightbulbIcon,
  broom: BroomIcon,
  reply: ArrowBendUpLeftIcon,
  export: ExportIcon,
  drives: HardDrivesIcon,
  key: KeyIcon,
  pulse: PulseIcon,
  clipboard: ClipboardTextIcon,
  package: PackageIcon,
  bug: BugIcon,
  flask: FlaskIcon,
  rocket: RocketIcon,
  bullets: ListBulletsIcon,
  text: TextAlignLeftIcon,
  browser: BrowserIcon,
  target: TargetIcon,
  path: PathIcon,
  hourglass: HourglassIcon,
  swatches: SwatchesIcon,
  moon: MoonStarsIcon,
  tag: TagIcon,
  hook: WebhooksLogoIcon,
  devices: DevicesIcon,
  'cursor-click': CursorClickIcon,
} satisfies Record<string, PhIcon>;

export type IconName = keyof typeof ICONS;

export interface IconProps {
  name: IconName;
  size?: number;
  /** Plain line icons by default ("regular"); tiny affordances like carets are "bold". */
  weight?: IconWeight;
  className?: string;
  style?: CSSProperties;
}

const THIN: Partial<Record<IconName, IconWeight>> = {
  'caret-down': 'bold',
  'caret-right': 'bold',
  'caret-left': 'bold',
  'caret-up': 'bold',
  'caret-updown': 'bold',
  check: 'bold',
  checks: 'bold',
  x: 'bold',
  plus: 'bold',
  minus: 'bold',
  'arrow-up': 'bold',
  'arrow-down': 'bold',
  'arrow-right': 'bold',
  'arrow-left': 'bold',
  'to-bottom': 'bold',
  dots: 'bold',
  'dots-vertical': 'bold',
  enter: 'bold',
  stop: 'fill',
  play: 'fill',
};

export function Icon({ name, size = 16, weight, className, style }: IconProps) {
  const Cmp = ICONS[name];
  return <Cmp size={size} weight={weight ?? THIN[name] ?? 'regular'} className={className} style={style} data-icon={name} aria-hidden />;
}

/**
 * Maps a tool kind to its icon. The interface is monochrome: every tone is the same neutral
 * (the field stays for callers that still pass it on).
 */
const NEUTRAL = 'var(--text-2)';
export const TOOL_ICON: Record<string, { icon: IconName; tone: string }> = {
  bash: { icon: 'prompt', tone: NEUTRAL },
  read: { icon: 'file-text', tone: NEUTRAL },
  edit: { icon: 'pencil', tone: NEUTRAL },
  write: { icon: 'file-plus', tone: NEUTRAL },
  search: { icon: 'file-search', tone: NEUTRAL },
  glob: { icon: 'folder-open', tone: NEUTRAL },
  fetch: { icon: 'globe', tone: NEUTRAL },
  websearch: { icon: 'globe', tone: NEUTRAL },
  agent: { icon: 'robot', tone: NEUTRAL },
  todo: { icon: 'tasks', tone: NEUTRAL },
  mcp: { icon: 'mcp', tone: NEUTRAL },
  question: { icon: 'question', tone: NEUTRAL },
  plan: { icon: 'compass', tone: NEUTRAL },
  skill: { icon: 'skill', tone: NEUTRAL },
  other: { icon: 'wrench', tone: NEUTRAL },
};

export const MODE_ICON: Record<string, IconName> = {
  ask: 'hand',
  edit: 'pencil',
  plan: 'compass',
  auto: 'fast-forward',
  danger: 'fire',
};

/** Tones that carry meaning (waiting on you, error) keep their hue; every other tone is neutral. */
const MEANINGFUL = /--(amber|red)\b/;

/**
 * An icon that identifies a thing (a tool call, a list row), in a box of `size` so rows align.
 * Plain and monochrome: no tile, no tint. `tone` only colours the icon when it means something
 * (amber, red); any other tone is ignored.
 */
export function Glyph({ name, tone, size = 26, iconSize, className }: { name: IconName; tone?: string; size?: number; iconSize?: number; className?: string }) {
  const style: CSSProperties = { width: size, height: size };
  if (tone && MEANINGFUL.test(tone)) style.color = tone;
  return (
    <span className={`glyph ${className ?? ''}`} style={style}>
      <Icon name={name} size={iconSize ?? Math.round(size * 0.62)} />
    </span>
  );
}

