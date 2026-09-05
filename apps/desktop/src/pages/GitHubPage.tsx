import { useCallback, useEffect, useRef, useState } from "react";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  connectGitHubWithToken,
  getGitHubStatus,
  ingestGitHubRepo,
  listGitHubRepos,
  pollGitHubDevice,
  startGitHubDeviceFlow,
  type DeviceCodeResponse,
  type GitHubRepo,
} from "@/lib/apiClient";

type ConnectState = "checking" | "disconnected" | "connecting" | "connected" | "error";

export function GitHubPage() {
  const [state, setState] = useState<ConnectState>("checking");
  const [username, setUsername] = useState<string | null>(null);
  const [deviceInfo, setDeviceInfo] = useState<DeviceCodeResponse | null>(null);
  const [deviceFlowAvailable, setDeviceFlowAvailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [repos, setRepos] = useState<GitHubRepo[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [ingesting, setIngesting] = useState<string | null>(null);
  const [ingested, setIngested] = useState<Set<string>>(new Set());
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number } | null>(null);
  const [tokenInput, setTokenInput] = useState("");
  const [connectingWithToken, setConnectingWithToken] = useState(false);
  const pollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refreshStatus = useCallback(async () => {
    const status = await getGitHubStatus();
    setDeviceFlowAvailable(status.deviceFlowAvailable ?? false);
    if (status.connected) {
      setState("connected");
      setUsername(status.username ?? null);
      const r = await listGitHubRepos();
      setRepos(r);
    } else {
      setState("disconnected");
    }
  }, []);

  useEffect(() => {
    refreshStatus();
    return () => {
      if (pollTimeoutRef.current) clearTimeout(pollTimeoutRef.current);
    };
  }, [refreshStatus]);

  const handleConnect = useCallback(async () => {
    setError(null);
    setState("connecting");
    try {
      const info = await startGitHubDeviceFlow();
      setDeviceInfo(info);
      window.open(info.verificationUri, "_blank");

      const poll = async () => {
        const result = await pollGitHubDevice(info.deviceCode);
        if (result.status === "success") {
          setDeviceInfo(null);
          await refreshStatus();
          return;
        }
        if (result.status === "expired") {
          setError("The connection code expired. Try again.");
          setState("disconnected");
          return;
        }
        if (result.status === "error") {
          setError(result.message);
          setState("disconnected");
          return;
        }
        pollTimeoutRef.current = setTimeout(poll, info.interval * 1000);
      };
      pollTimeoutRef.current = setTimeout(poll, info.interval * 1000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start GitHub connection");
      setState("error");
    }
  }, [refreshStatus]);

  const handleConnectWithToken = useCallback(async () => {
    if (!tokenInput.trim()) return;
    setError(null);
    setConnectingWithToken(true);
    try {
      await connectGitHubWithToken(tokenInput.trim());
      setTokenInput("");
      await refreshStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to connect with that token");
    } finally {
      setConnectingWithToken(false);
    }
  }, [tokenInput, refreshStatus]);

  const handleIngest = useCallback(async (repo: GitHubRepo) => {
    setIngesting(repo.fullName);
    setError(null);
    try {
      await ingestGitHubRepo(repo.owner, repo.name);
      setIngested((prev) => new Set(prev).add(repo.fullName));
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to ingest ${repo.fullName}`);
    } finally {
      setIngesting(null);
    }
  }, []);

  const toggleSelected = useCallback((fullName: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(fullName)) next.delete(fullName);
      else next.add(fullName);
      return next;
    });
  }, []);

  const handleIngestSelected = useCallback(async () => {
    const targets = repos.filter((r) => selected.has(r.fullName));
    if (targets.length === 0) return;

    setError(null);
    setBulkProgress({ done: 0, total: targets.length });

    // Sequential, not parallel: each ingestion runs an LLM call for project
    // profile extraction plus local embeddings — same reasoning as the
    // multi-file knowledge upload, this machine can't do several at once
    // without starving each other.
    const failures: string[] = [];
    for (let i = 0; i < targets.length; i++) {
      const repo = targets[i];
      setIngesting(repo.fullName);
      try {
        await ingestGitHubRepo(repo.owner, repo.name);
        setIngested((prev) => new Set(prev).add(repo.fullName));
      } catch (err) {
        failures.push(`${repo.fullName}: ${err instanceof Error ? err.message : "failed"}`);
      }
      setBulkProgress({ done: i + 1, total: targets.length });
    }

    setIngesting(null);
    setBulkProgress(null);
    setSelected(new Set());
    if (failures.length > 0) setError(failures.join("; "));
  }, [repos, selected]);

  return (
    <div>
      <PageHeader
        title="GitHub"
        description="Connect your account and select repositories to build project profiles from."
      />
      <div className="max-w-2xl space-y-4 p-8">
        {state === "connected" ? (
          <>
            <div className="flex items-center justify-between gap-2">
              <Badge>Connected as {username}</Badge>
              <Button
                size="sm"
                disabled={selected.size === 0 || bulkProgress !== null}
                onClick={handleIngestSelected}
              >
                {bulkProgress
                  ? `Ingesting ${bulkProgress.done}/${bulkProgress.total}...`
                  : `Ingest selected${selected.size > 0 ? ` (${selected.size})` : ""}`}
              </Button>
            </div>
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
            <ul className="space-y-2">
              {repos.map((repo) => (
                <li
                  key={repo.id}
                  className="flex items-center justify-between rounded-md border border-border px-4 py-3"
                >
                  <div className="flex items-start gap-3">
                    <Checkbox
                      checked={selected.has(repo.fullName)}
                      onCheckedChange={() => toggleSelected(repo.fullName)}
                      className="mt-1"
                    />
                    <div>
                      <p className="text-sm font-medium">{repo.fullName}</p>
                      {repo.description ? (
                        <p className="text-xs text-muted-foreground">{repo.description}</p>
                      ) : null}
                      {repo.language ? (
                        <Badge variant="secondary" className="mt-1 text-xs">
                          {repo.language}
                        </Badge>
                      ) : null}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant={ingested.has(repo.fullName) ? "outline" : "default"}
                    disabled={ingesting === repo.fullName || bulkProgress !== null}
                    onClick={() => handleIngest(repo)}
                  >
                    {ingesting === repo.fullName
                      ? "Ingesting..."
                      : ingested.has(repo.fullName)
                        ? "Re-ingest"
                        : "Ingest"}
                  </Button>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <Card>
            <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
              {state === "connecting" && deviceInfo ? (
                <>
                  <p className="text-sm">
                    Enter this code at{" "}
                    <a
                      href={deviceInfo.verificationUri}
                      className="underline"
                      onClick={(e) => {
                        e.preventDefault();
                        window.open(deviceInfo.verificationUri, "_blank");
                      }}
                    >
                      {deviceInfo.verificationUri}
                    </a>
                  </p>
                  <p className="text-2xl font-mono tracking-widest">{deviceInfo.userCode}</p>
                  <p className="text-xs text-muted-foreground">Waiting for approval...</p>
                </>
              ) : (
                <>
                  <p className="text-sm text-muted-foreground">Not connected.</p>
                  {deviceFlowAvailable ? (
                    <Button onClick={handleConnect} disabled={state === "connecting"}>
                      {state === "connecting" ? "Starting..." : "Connect GitHub"}
                    </Button>
                  ) : null}
                  <div className="flex w-full max-w-sm flex-col gap-2 text-left">
                    <p className="text-xs text-muted-foreground">
                      {deviceFlowAvailable
                        ? "Or paste a personal access token instead:"
                        : "Paste a personal access token to connect (needs at least read access to repository contents & metadata):"}
                    </p>
                    <div className="flex gap-2">
                      <Input
                        type="password"
                        placeholder="github_pat_..."
                        value={tokenInput}
                        onChange={(e) => setTokenInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") handleConnectWithToken();
                        }}
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={handleConnectWithToken}
                        disabled={connectingWithToken || !tokenInput.trim()}
                      >
                        {connectingWithToken ? "Connecting..." : "Connect"}
                      </Button>
                    </div>
                  </div>
                </>
              )}
              {error ? <p className="text-xs text-destructive">{error}</p> : null}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
