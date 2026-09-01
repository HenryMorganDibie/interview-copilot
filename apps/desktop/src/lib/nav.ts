import {
  BookOpen,
  FileText,
  GitBranch,
  LayoutDashboard,
  Mic,
  Settings,
  Sparkles,
  type LucideIcon,
} from "lucide-react";

export type NavItem = {
  path: string;
  label: string;
  icon: LucideIcon;
};

export const navItems: NavItem[] = [
  { path: "/", label: "Overview", icon: LayoutDashboard },
  { path: "/knowledge-base", label: "Knowledge Base", icon: BookOpen },
  { path: "/github", label: "GitHub", icon: GitBranch },
  { path: "/job-descriptions", label: "Job Descriptions", icon: FileText },
  { path: "/session-setup", label: "Session Setup", icon: Sparkles },
  { path: "/settings", label: "Settings", icon: Settings },
];

export const liveSessionPath = "/live";
export const liveSessionIcon = Mic;
