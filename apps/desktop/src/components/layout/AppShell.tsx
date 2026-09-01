import { NavLink, Outlet } from "react-router-dom";
import { cn } from "@/lib/utils";
import { navItems, liveSessionPath, liveSessionIcon as LiveIcon } from "@/lib/nav";
import { Button } from "@/components/ui/button";

export function AppShell() {
  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground">
      <aside className="flex w-56 shrink-0 flex-col border-r border-border p-3">
        <div className="mb-4 px-2 pt-1">
          <p className="text-sm font-semibold tracking-tight">Interview Copilot</p>
          <p className="text-xs text-muted-foreground">Personal knowledge engine</p>
        </div>

        <nav className="flex flex-1 flex-col gap-1">
          {navItems.map((item) => (
            <NavLink
              key={item.path}
              to={item.path}
              end={item.path === "/"}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
                  isActive
                    ? "bg-secondary text-secondary-foreground"
                    : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
                )
              }
            >
              <item.icon className="size-4" />
              {item.label}
            </NavLink>
          ))}
        </nav>

        <Button asChild className="mt-2 gap-2">
          <NavLink to={liveSessionPath}>
            <LiveIcon className="size-4" />
            Start Live Interview
          </NavLink>
        </Button>
      </aside>

      <main className="flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  );
}
