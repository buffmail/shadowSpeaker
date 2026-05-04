"use client";

import { useState, useRef, useEffect, ReactNode } from "react";
import { parseSync } from "subtitle";
import {
  opfsDelete,
  opfsExist,
  opfsListProjects,
  opfsRead,
  opfsWrite,
} from "./util/opfs";
import { AudioSample, splitMp3Segments, makeSilentWav } from "./util/sample";
import { nanoid } from "nanoid";
import memoizeOne from "memoize-one";
import { produce } from "immer";

type Tone = "primary" | "success" | "danger" | "muted" | "slate";

const TONE_CLASSES: Record<Tone, string> = {
  primary: "bg-blue-500 hover:bg-blue-600",
  success: "bg-green-500 hover:bg-green-600",
  danger: "bg-red-500 hover:bg-red-600",
  muted: "bg-gray-500 hover:bg-gray-600",
  slate: "bg-slate-400 hover:bg-slate-500",
};

const ActionButton = ({
  tone,
  onClick,
  className = "",
  children,
}: {
  tone: Tone;
  onClick: () => void;
  className?: string;
  children: ReactNode;
}) => (
  <button
    onClick={onClick}
    className={`cursor-pointer ${TONE_CLASSES[tone]} text-white px-6 py-3 rounded-lg font-medium transition-colors ${className}`}
  >
    {children}
  </button>
);

const LS_INDEX = "lastPlayIndex";
const LS_LAST_PROJECT = "lastProject";
const SCENE_TAG = /^\[SCENE] /;

const BUILD_TIME_ISO =
  process.env.NEXT_PUBLIC_BUILD_TIME ?? new Date().toISOString();

const loadPlayIndex = () => {
  if (typeof window === "undefined") {
    return 0;
  }
  const idxStr = window.localStorage.getItem(LS_INDEX);
  if (!idxStr) return 0;
  return parseInt(idxStr);
};

const savePlayIndex = (index: number) => {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(LS_INDEX, index.toString());
};

const loadLastProject = (): string | undefined => {
  if (typeof window === "undefined") {
    return;
  }
  const projectStr = window.localStorage.getItem(LS_LAST_PROJECT);
  if (!projectStr) return;
  return projectStr;
};

const saveLastProject = (project: string) => {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(LS_LAST_PROJECT, project);
};

const loadSceneSegIndices = async (projectName: string): Promise<number[]> => {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const blob = await opfsRead(projectName, OPFS_SCENE_INDICES_NAME);
    if (!blob) {
      return [];
    }
    const decoder = new TextDecoder();
    const sceneStr = decoder.decode(blob);
    if (!sceneStr) {
      return [];
    }
    const indices = JSON.parse(sceneStr);
    if (!Array.isArray(indices)) {
      throw new Error("scene indices is not an array");
    }
    return indices;
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") {
      return [];
    }
    window.console.error("error during parsing scene indices", error);
    return [];
  }
};

const saveSceneSegIndices = async (projectName: string, indices: number[]) => {
  if (typeof window === "undefined") {
    return;
  }
  const blob = new Blob([JSON.stringify(indices)], { type: "text/plain" });
  await opfsWrite(projectName, OPFS_SCENE_INDICES_NAME, blob);
};

const loadFavoriteIndices = async (projectName: string): Promise<number[]> => {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const blob = await opfsRead(projectName, OPFS_FAVORITE_INDICES_NAME);
    if (!blob) {
      return [];
    }
    const decoder = new TextDecoder();
    const favStr = decoder.decode(blob);
    if (!favStr) {
      return [];
    }
    const indices = JSON.parse(favStr);
    if (!Array.isArray(indices)) {
      throw new Error("favorite indices is not an array");
    }
    return indices;
  } catch (error) {
    if (
      error instanceof DOMException &&
      error.name === "NotFoundError"
    ) {
      return [];
    }
    window.console.error("error during parsing favorite indices", error);
    return [];
  }
};

const saveFavoriteIndices = async (projectName: string, indices: number[]) => {
  if (typeof window === "undefined") {
    return;
  }
  const blob = new Blob([JSON.stringify(indices)], { type: "text/plain" });
  await opfsWrite(projectName, OPFS_FAVORITE_INDICES_NAME, blob);
};

const getRowId = (index: number) => `id-${index}`;

const getFileNameWithoutExt = (fileName: string) => {
  return fileName.split(".")[0];
};

interface FilePickerAcceptType {
  description: string;
  accept: {
    [key: string]: string[];
  };
}

interface FilePickerOptions {
  types?: FilePickerAcceptType[];
  excludeAcceptAllOption?: boolean;
  multiple?: boolean;
}

declare global {
  interface Window {
    showOpenFilePicker(
      options?: FilePickerOptions
    ): Promise<FileSystemFileHandle[]>;
  }
}

const OPFS_SRT_NAME = "transcript.srt";
const OPFS_VTT_NAME = "transcript.vtt";
const OPFS_SCENE_INDICES_NAME = "sceneIndices.json";
const OPFS_FAVORITE_INDICES_NAME = "favoriteIndices.json";
const OPFS_STATS_NAME = "stats.json";

interface ProjectStats {
  playCount: number;
  totalDurationSec: number;
  startDate: string;
}

const getTodayISODate = (): string => {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const formatHHMMSS = (seconds: number): string => {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
};

const elapsedDays = (startDate: string): number => {
  const start = new Date(`${startDate}T00:00:00`);
  const now = new Date();
  const startMidnight = new Date(
    start.getFullYear(),
    start.getMonth(),
    start.getDate()
  ).getTime();
  const todayMidnight = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate()
  ).getTime();
  return Math.max(
    0,
    Math.floor((todayMidnight - startMidnight) / 86400000)
  );
};

const loadStats = async (
  projectName: string
): Promise<ProjectStats | null> => {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const blob = await opfsRead(projectName, OPFS_STATS_NAME);
    if (!blob) return null;
    const decoder = new TextDecoder();
    const str = decoder.decode(blob);
    if (!str) return null;
    const parsed = JSON.parse(str);
    if (
      parsed &&
      typeof parsed.playCount === "number" &&
      typeof parsed.totalDurationSec === "number" &&
      typeof parsed.startDate === "string"
    ) {
      return parsed as ProjectStats;
    }
    throw new Error("invalid project stats shape");
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") {
      return null;
    }
    window.console.error("error during parsing project stats", error);
    return null;
  }
};

const saveStats = async (projectName: string, stats: ProjectStats) => {
  if (typeof window === "undefined") {
    return;
  }
  const blob = new Blob([JSON.stringify(stats)], { type: "text/plain" });
  await opfsWrite(projectName, OPFS_STATS_NAME, blob);
};

const findSubtitleFile = async (
  project: string
): Promise<string | undefined> => {
  if (await opfsExist(project, OPFS_SRT_NAME)) return OPFS_SRT_NAME;
  if (await opfsExist(project, OPFS_VTT_NAME)) return OPFS_VTT_NAME;
  return undefined;
};

interface Segment {
  startTime: number;
  endTime: number;
  text: string;
  sceneId: string;
}

interface RangeInfo {
  beginIdx: number;
  endIdx: number;
}

interface PlayContext {
  audioContext: AudioContext;
  audioSample: AudioSample;
  playInfo?: {
    rangeInfo?: RangeInfo;
    abSrcNode: AudioBufferSourceNode;
    stopListener?: () => void;
  };
}

const stopPlayback = (playContext: PlayContext) => {
  const playInfo = playContext.playInfo;
  if (!playInfo) {
    return;
  }

  if (playInfo.stopListener) {
    playInfo.abSrcNode.removeEventListener("ended", playInfo.stopListener);
  }
  playInfo.abSrcNode.stop();
  playContext.playInfo = undefined;

  if (navigator?.mediaSession) {
    navigator.mediaSession.playbackState = "paused";

    navigator.mediaSession.setPositionState({
      duration: 0,
      playbackRate: 1,
      position: 0,
    });
  }
};

const beep = (audioContext: AudioContext, onEnd: () => void) => {
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  const durationSec = 0.1;

  oscillator.type = "sine";
  oscillator.frequency.value = 880;
  gain.gain.value = 0.2;

  oscillator.connect(gain);
  gain.connect(audioContext.destination);

  oscillator.start();
  oscillator.stop(audioContext.currentTime + durationSec);

  oscillator.onended = () => {
    oscillator.disconnect();
    gain.disconnect();
    onEnd();
  };
};

const getAllSceneIds = memoizeOne((segments: Segment[]): string[] => {
  return segments
    .map((segment) => segment.sceneId)
    .filter((e, i, a) => a.indexOf(e) === i);
});

const getPrevSceneId = (segments: Segment[], sceneId: string): string => {
  const sceneIds = getAllSceneIds(segments);
  const sceneIdIdx = sceneIds.indexOf(sceneId);
  return sceneIds[sceneIdIdx - 1];
};

const getSceneSegIndex = (
  segments: Segment[],
  sceneId: string
): { beginIdx: number; endIdx: number } | undefined => {
  const beginIdx = segments.findIndex((segment) => segment.sceneId === sceneId);
  if (beginIdx === -1) {
    return undefined;
  }
  let endIdx = undefined;
  for (let i = beginIdx; i < segments.length; ++i) {
    if (segments[i].sceneId !== sceneId) {
      endIdx = i;
      break;
    }
  }
  if (endIdx === undefined) {
    endIdx = segments.length;
  }
  return { beginIdx, endIdx };
};

const getNextSceneId = (segments: Segment[], sceneId: string): string => {
  const sceneIds = getAllSceneIds(segments);
  const sceneIdIdx = sceneIds.indexOf(sceneId);
  return sceneIds[sceneIdIdx + 1];
};

const splitScenes = (
  segments: Segment[],
  segIdx: number,
  type: "split" | "merge"
): Segment[] => {
  if (segIdx < 0 || segIdx >= segments.length) {
    return segments;
  }
  const origSceneId = segments[segIdx].sceneId;
  const prevSceneId = getPrevSceneId(segments, origSceneId);
  const newSceneId = type === "split" ? nanoid() : prevSceneId;
  return produce(segments, (draft) => {
    for (let i = segIdx; i < segments.length; ++i) {
      if (draft[i].sceneId === origSceneId) {
        draft[i].sceneId = newSceneId;
      } else {
        break;
      }
    }
  });
};

export default function Home() {
  const [status, setStatus] = useState<string>("");
  const playCtxRef = useRef<PlayContext | undefined>(undefined);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [segIndex, setSegIndex] = useState<number>(0);
  const [scenes, setScenes] = useState<number>(0);
  const [favoriteIndices, setFavoriteIndices] = useState<Set<number>>(new Set());
  const [stats, setStats] = useState<ProjectStats | null>(null);
  const statsRef = useRef<ProjectStats | null>(null);
  const [menuOpen, setMenuOpen] = useState<boolean>(false);
  const [projectPickerOpen, setProjectPickerOpen] = useState<boolean>(false);
  const [availableProjects, setAvailableProjects] = useState<string[]>([]);
  const [buildTime, setBuildTime] = useState<string>("");
  const segLengthRef = useRef<number>(0);
  const playAudioSegmentRef = useRef<typeof playAudioSegment | undefined>(
    undefined
  );
  const dummyAudioRef = useRef<HTMLAudioElement | undefined>(undefined);
  const [stuck, setStuck] = useState<boolean>(false);
  const stickyHeaderRef = useRef<HTMLDivElement>(null);
  const project = loadLastProject() ?? "";

  useEffect(() => {
    const onScroll = () => setStuck(window.scrollY > 0);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    const project = loadLastProject() ?? "";
    const audioContext = new AudioContext();
    const audioSample = new AudioSample(audioContext, setStatus);
    const playContext: PlayContext = { audioContext, audioSample };
    playCtxRef.current = playContext;

    const dummyAudio = document.createElement("audio");
    const silenceWavBase64 = makeSilentWav(6000);
    dummyAudio.src = silenceWavBase64;
    dummyAudio.loop = true;
    dummyAudioRef.current = dummyAudio;

    const lastIdx = loadPlayIndex();
    setSegIndex(lastIdx);

    if (navigator?.mediaSession) {
      navigator.mediaSession.metadata = new window.MediaMetadata({
        title: "ShadowSpeaker",
        artist: "",
      });

      navigator.mediaSession.setPositionState({
        duration: 0,
        playbackRate: 1,
        position: 0,
      });

      navigator.mediaSession.playbackState = "paused";

      navigator.mediaSession.setActionHandler("pause", () => {
        setStatus("Paused by headset/media key");
        stopPlayback(playContext);
        dummyAudioRef.current?.pause();
      });
      navigator.mediaSession.setActionHandler("play", () => {
        playAudioSegmentRef.current?.(loadPlayIndex(), false);
      });
    }

    (async () => {
      const loaded = await audioSample.initSample(setStatus, project);
      if (!loaded) {
        setStatus(`No sample found`);
        return;
      }

      const subtitleFile = await findSubtitleFile(project);
      if (!subtitleFile) {
        setStatus(`No subtitle found`);
        return;
      }

      const subtitleContent = await opfsRead(project, subtitleFile);
      const decoder = new TextDecoder();
      const subtitleString = decoder.decode(subtitleContent);
      setStatus(`Loading ${subtitleFile}…`);

      let sceneId = "";

      const sceneSegIndices = await loadSceneSegIndices(project);

      const segments: Segment[] = parseSync(subtitleString)
        .flatMap((node) => (node.type === "cue" ? [node.data] : []))
        .map((elem, idx) => {
          const { start, end, text } = elem;

          const revisedText = text.replace(SCENE_TAG, "");
          if (
            idx === 0 ||
            SCENE_TAG.test(text) ||
            sceneSegIndices.includes(idx)
          ) {
            sceneId = nanoid();
          }

          return {
            startMsec: Math.round(start),
            endMsec: Math.round(end),
            text: revisedText,
            sceneId,
          };
        })
        .map((elem, idx, all) => {
          const prevElem = all[idx - 1];
          const nextElem = all[idx + 1];

          const prevGapMsec =
            prevElem === undefined ? 0 : elem.startMsec - prevElem.endMsec;
          const nextGapMsec =
            nextElem === undefined ? 0 : nextElem.startMsec - elem.endMsec;

          const MAX_GAP_MSEC = 400;
          const startMsec =
            elem.startMsec - Math.min(MAX_GAP_MSEC, prevGapMsec / 2);
          const endMsec =
            elem.endMsec + Math.min(MAX_GAP_MSEC, nextGapMsec / 2);

          return {
            startTime: startMsec / 1000,
            endTime: endMsec / 1000,
            text: elem.text,
            sceneId: elem.sceneId,
          };
        });
      setSegments(segments);
      segLengthRef.current = segments.length;
      setScenes(getAllSceneIds(segments).length);
      const favs = await loadFavoriteIndices(project);
      setFavoriteIndices(new Set(favs));

      let loadedStats = await loadStats(project);
      if (!loadedStats) {
        loadedStats = {
          playCount: 0,
          totalDurationSec: 0,
          startDate: getTodayISODate(),
        };
        saveStats(project, loadedStats);
      }
      statsRef.current = loadedStats;
      setStats(loadedStats);

      setStatus(`Current: ${lastIdx + 1} / ${segments.length}`);
    })();

    return () => {
      navigator?.mediaSession?.setActionHandler("play", null);
      navigator?.mediaSession?.setActionHandler("pause", null);
      audioContext.close();
    };
  }, []);

  useEffect(() => {
    const date = new Date(BUILD_TIME_ISO);
    const formatted = date.toLocaleString("en-US");
    const tzName = new Intl.DateTimeFormat("en-US", { timeZoneName: "short" })
      .formatToParts(date)
      .find((part) => part.type === "timeZoneName")?.value;
    setBuildTime(tzName ? `${formatted} (${tzName})` : formatted);
  }, []);

  useEffect(() => {
    if (!menuOpen && !projectPickerOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (projectPickerOpen) setProjectPickerOpen(false);
      else if (menuOpen) setMenuOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [menuOpen, projectPickerOpen]);

  const playAudioSegment = async (
    index: number,
    singleEntryLoop: boolean,
    initRangeInfo?: RangeInfo
  ) => {
    try {
      const playContext = playCtxRef.current;
      if (!playContext) return;
      const { audioContext, audioSample } = playContext;
      if (!audioSample.isLoaded()) return;

      const prevRangeInfo = playContext.playInfo?.rangeInfo;
      stopPlayback(playContext);

      const segment = segments[index];
      if (!segment) {
        return;
      }
      const startSec = segment.startTime;
      const durationSec = segment.endTime - segment.startTime;
      const sceneId = segment.sceneId;

      setSegIndex(index);
      savePlayIndex(index);

      if (statsRef.current) {
        const next: ProjectStats = {
          ...statsRef.current,
          playCount: statsRef.current.playCount + 1,
          totalDurationSec: statsRef.current.totalDurationSec + durationSec,
        };
        statsRef.current = next;
        setStats(next);
        saveStats(project, next);
      }

      const abSrcNode = audioContext.createBufferSource();

      const segmentBuffer = await audioSample.createSegmentBuffer(
        startSec,
        durationSec,
        project
      );

      abSrcNode.buffer = segmentBuffer;
      abSrcNode.connect(audioContext.destination);
      abSrcNode.loop = singleEntryLoop;

      let stopListener: undefined | (() => void) = undefined;
      let rangeInfo: RangeInfo | undefined = undefined;

      if (singleEntryLoop === false) {
        const sceneBeginIdx = segments.findIndex(
          (elem) => elem.sceneId === sceneId
        );
        const sceneIds = getAllSceneIds(segments);
        const sceneIdIdx = sceneIds.indexOf(sceneId);
        const nextSceneId = sceneIds[sceneIdIdx + 1];
        const sceneEndIdx =
          nextSceneId === undefined
            ? segments.length
            : segments.findIndex((elem) => elem.sceneId === nextSceneId);
        const newBeginIdx = sceneBeginIdx === -1 ? index : sceneBeginIdx;
        const newEndIdx = sceneEndIdx === -1 ? segments.length : sceneEndIdx;
        rangeInfo = initRangeInfo ??
          prevRangeInfo ?? {
            beginIdx: newBeginIdx,
            endIdx: newEndIdx,
          };
        let nextIndex = index + 1;
        if (nextIndex >= rangeInfo.endIdx) {
          nextIndex = rangeInfo.beginIdx;
        }
        stopListener = () => {
          playAudioSegment(nextIndex, singleEntryLoop);
        };
        abSrcNode.addEventListener("ended", stopListener);
      }

      playContext.playInfo = { abSrcNode, stopListener, rangeInfo };

      if (navigator?.mediaSession) {
        navigator.mediaSession.setPositionState({
          duration: durationSec,
          playbackRate: 1,
          position: 0,
        });

        navigator.mediaSession.playbackState = "playing";
        navigator.mediaSession.metadata = new window.MediaMetadata({
          title: segment.text,
          artist: `Segment ${index + 1} / ${segments.length}`,
        });
      }

      const playBeep = rangeInfo?.beginIdx === index;
      if (playBeep) {
        beep(audioContext, () => abSrcNode.start());
      } else {
        abSrcNode.start();
      }
      dummyAudioRef.current?.play();

      const rangeStr = rangeInfo
        ? `[${getAllSceneIds(segments).indexOf(sceneId) + 1}/${scenes}]`
        : "";
      const progressPercent = Math.round(((index + 1) / segments.length) * 100);
      setStatus(`Current: ${progressPercent}% ${rangeStr}`);

      const row = document.getElementById(getRowId(index));
      if (row) {
        const headerHeight = stickyHeaderRef.current?.offsetHeight ?? 0;
        const rowRect = row.getBoundingClientRect();
        const rowCenterAbsolute =
          rowRect.top + window.scrollY + rowRect.height / 2;
        const visibleAreaCenter =
          headerHeight + (window.innerHeight - headerHeight) / 2;
        window.scrollTo({
          top: rowCenterAbsolute - visibleAreaCenter,
          behavior: "smooth",
        });
      }
    } catch (error) {
      console.error("Error playing audio:", error);
      setStatus("Error playing audio segment");
    }
  };
  playAudioSegmentRef.current = playAudioSegment;

  const navigateNext = () => {
    const segment = segments[segIndex] ?? segments[0];
    if (!segment) return;
    const scenePlay = !!playCtx?.playInfo?.rangeInfo;

    if (scenePlay) {
      const targetSceneId = getNextSceneId(segments, segment.sceneId);
      const range = getSceneSegIndex(segments, targetSceneId);
      if (!range) return;
      playAudioSegment(range.beginIdx, false, {
        beginIdx: range.beginIdx,
        endIdx: range.endIdx,
      });
      return;
    }

    const targetIdx = segIndex + 1;
    if (targetIdx < segments.length) {
      playAudioSegment(targetIdx, true);
    }
  };

  const togglePlay = async () => {
    if (!playCtx) return;
    if (playInfo) {
      stopPlayback(playCtx);
      setStatus("Stopped");
      return;
    }
    if (playCtx.audioContext.state === "suspended") {
      await playCtx.audioContext.resume();
    }
    playAudioSegment(segIndex, false);
  };

  const toggleFavorite = (index: number) => {
    setFavoriteIndices((prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      saveFavoriteIndices(project, Array.from(next));
      return next;
    });
  };

  const toggleSplitScene = async () => {
    const sceneSegIndices = await loadSceneSegIndices(project);
    const alreadySplit = sceneSegIndices.includes(segIndex);
    setSegments(splitScenes(segments, segIndex, alreadySplit ? "merge" : "split"));
    const newIndices = alreadySplit
      ? sceneSegIndices.filter((idx) => idx !== segIndex)
      : [...sceneSegIndices, segIndex];
    saveSceneSegIndices(project, newIndices);
  };

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch (err) {
      console.error("Clipboard copy error:", err);
    }
  };

  const copySegmentText = () => {
    const segment = segments[segIndex];
    if (segment) copyToClipboard(segment.text);
  };

  const copySceneText = () => {
    const segment = segments[segIndex];
    if (!segment) return;
    const sceneText = segments
      .filter((s) => s.sceneId === segment.sceneId)
      .map((s) => s.text)
      .join("\n");
    copyToClipboard(sceneText);
  };

  const handleFileSelect = async (input: "audio" | "subtitle") => {
    if (!playCtx) {
      return;
    }
    try {
      const [fileHandle] = await window?.showOpenFilePicker({
        types:
          input === "audio"
            ? [
                {
                  description: "Audio Files",
                  accept: { "audio/*": [".mp3", ".wav", ".m4a", ".ogg"] },
                },
              ]
            : [
                {
                  description: "Subtitle Files",
                  accept: {
                    "text/plain": [".srt", ".vtt"],
                    "application/x-subrip": [".srt"],
                    "text/srt": [".srt"],
                    "application/srt": [".srt"],
                    "text/vtt": [".vtt"],
                  },
                },
              ],
      });

      const newProject =
        input === "audio" ? getFileNameWithoutExt(fileHandle.name) : project;

      const file = await fileHandle.getFile();
      if (input === "subtitle") {
        const isVtt = file.name.toLowerCase().endsWith(".vtt");
        const targetName = isVtt ? OPFS_VTT_NAME : OPFS_SRT_NAME;
        const otherName = isVtt ? OPFS_SRT_NAME : OPFS_VTT_NAME;
        await opfsWrite(newProject, targetName, file);
        await opfsDelete(newProject, otherName);
        window?.location.reload();
        return;
      }

      setStatus(`Decoding audio…`);
      const arrayBuffer = await file.arrayBuffer();
      const audioBuffer = await playCtx.audioContext.decodeAudioData(
        arrayBuffer
      );

      await splitMp3Segments(audioBuffer, setStatus, newProject);
      saveLastProject(newProject);
      window?.location.reload();
    } catch (error) {
      console.error("Error handling file:", error);
      setStatus(`Error processing ${input} file`);
    }
  };

  const playCtx = playCtxRef.current;
  if (!playCtx) {
    return null;
  }

  const { audioSample, playInfo } = playCtx;

  const isLoaded = audioSample.isLoaded();

  const runFromMenu = (handler: () => void) => () => {
    setMenuOpen(false);
    handler();
  };

  const openProjectPicker = async () => {
    try {
      const projects = await opfsListProjects();
      setAvailableProjects(projects);
      setProjectPickerOpen(true);
    } catch (error) {
      console.error("Failed to list projects:", error);
      setStatus("Failed to load projects");
    }
  };

  const selectProject = (name: string) => {
    if (!name || name === project) {
      setProjectPickerOpen(false);
      return;
    }
    saveLastProject(name);
    window.location.reload();
  };

  return (
    <main className="min-h-screen flex items-center justify-center py-4 sm:py-8">
      <button
        onClick={() => setMenuOpen(true)}
        aria-label="Open menu"
        aria-expanded={menuOpen}
        className="fixed top-4 right-4 z-30 p-2 rounded-md bg-white/80 dark:bg-gray-800/80 backdrop-blur border border-gray-200 dark:border-gray-700 hover:bg-white dark:hover:bg-gray-800 transition-colors"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-gray-700 dark:text-gray-200"
        >
          <line x1="3" y1="6" x2="21" y2="6" />
          <line x1="3" y1="12" x2="21" y2="12" />
          <line x1="3" y1="18" x2="21" y2="18" />
        </svg>
      </button>

      <div className="flex flex-col items-center gap-4 w-full">
        <div
          ref={stickyHeaderRef}
          className={`sticky top-0 z-10 bg-white dark:bg-gray-900 w-full flex flex-col items-center transition-[padding,gap] ${
            stuck ? "py-1 gap-1" : "py-4 gap-4"
          }`}
        >
          <div
            className={`flex flex-col-reverse landscape:flex-row items-center landscape:gap-8 ${
              stuck ? "gap-1" : "gap-4"
            }`}
          >
            <p className="text-gray-600 dark:text-gray-400 text-center text-lg sm:text-2xl">
              {status}
            </p>
            {isLoaded && (
              <div className="flex gap-4 items-center">
                <ActionButton
                  tone={playInfo ? "danger" : "success"}
                  onClick={togglePlay}
                >
                  {playInfo ? "Stop" : "Play"}
                </ActionButton>
                <ActionButton tone="primary" onClick={navigateNext}>
                  Next
                </ActionButton>
              </div>
            )}
          </div>
        </div>
        {segments.length > 0 && (
          <div className="mt-4 w-full overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-gray-800">
                  <th className="p-2 w-12 sm:w-16 select-none">No.</th>
                  <th className="p-2 min-w-0 text-left select-none">Text</th>
                  <th className="p-2 w-16 sm:w-24 select-none"></th>
                </tr>
              </thead>
              <tbody>
                {segments.map((segment, index) => {
                  const betweenRange = playInfo?.rangeInfo
                    ? playInfo.rangeInfo.beginIdx <= index &&
                      index < playInfo.rangeInfo.endIdx
                    : false;
                  const isNewScene =
                    segment.sceneId !== segments[index - 1]?.sceneId;
                  return (
                    <tr
                      key={index}
                      id={getRowId(index)}
                      style={{
                        backgroundColor:
                          index === segIndex ? "#4B5563" : "transparent",
                        borderTop: isNewScene ? "3px solid #3B82F6" : undefined,
                      }}
                    >
                      <td
                        className={`p-1 sm:p-2 text-center select-none ${
                          betweenRange ? "border-l-2 border-blue-500" : ""
                        }`}
                      >
                        {index + 1}
                      </td>
                      <td
                        className="p-1 sm:p-2 break-words min-w-0 select-none"
                        onPointerDown={(e) => {
                          e.persist?.();
                          const timeoutId = setTimeout(() => {
                            toggleFavorite(index);
                          }, 500);
                          const clear = () => clearTimeout(timeoutId);
                          e.target.addEventListener("pointerup", clear, {
                            once: true,
                          });
                          e.target.addEventListener("pointerleave", clear, {
                            once: true,
                          });
                        }}
                      >
                        {favoriteIndices.has(index) && (
                          <span className="mr-1 text-yellow-400">★</span>
                        )}
                        {segment.text}
                      </td>
                      <td className="p-1 sm:p-2 select-none">
                        <button
                          className="px-1.5 py-0.5 rounded text-xs select-none flex items-center justify-center bg-blue-500 text-white"
                          onClick={() => playAudioSegment(index, true)}
                          aria-label="Play"
                        >
                          <svg
                            xmlns="http://www.w3.org/2000/svg"
                            width="13"
                            height="13"
                            viewBox="0 0 20 20"
                            fill="currentColor"
                            className="inline-block"
                          >
                            <polygon points="5,3 17,10 5,17" />
                          </svg>
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {menuOpen && (
        <>
          <div
            className="fixed inset-0 bg-black/50 z-40"
            onClick={() => setMenuOpen(false)}
            aria-hidden="true"
          />
          <aside
            className="fixed top-0 right-0 h-full w-72 max-w-[85vw] bg-white dark:bg-gray-900 z-50 p-4 shadow-xl flex flex-col gap-3"
            role="dialog"
            aria-label="Menu"
          >
            <div className="flex items-center justify-between mb-1">
              <h2 className="text-lg font-medium text-gray-700 dark:text-gray-200">
                Menu
              </h2>
              <button
                onClick={() => setMenuOpen(false)}
                aria-label="Close menu"
                className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-200 text-xl leading-none"
              >
                ×
              </button>
            </div>
            <div className="mb-2 text-sm text-gray-500 dark:text-gray-400 truncate">
              <span className="text-gray-400 dark:text-gray-500">Project: </span>
              <span className="text-gray-700 dark:text-gray-200">
                {project || "(none)"}
              </span>
            </div>
            <div className="mb-2 text-sm text-gray-500 dark:text-gray-400">
              <span className="text-gray-400 dark:text-gray-500">Favorites: </span>
              <span className="text-gray-700 dark:text-gray-200">
                {favoriteIndices.size}
              </span>
            </div>
            {stats && (
              <>
                <div className="mb-2 text-sm text-gray-500 dark:text-gray-400">
                  <span className="text-gray-400 dark:text-gray-500">Plays: </span>
                  <span className="text-gray-700 dark:text-gray-200">
                    {stats.playCount}
                  </span>
                </div>
                <div className="mb-2 text-sm text-gray-500 dark:text-gray-400">
                  <span className="text-gray-400 dark:text-gray-500">Time: </span>
                  <span className="text-gray-700 dark:text-gray-200">
                    {formatHHMMSS(stats.totalDurationSec)}
                  </span>
                </div>
                <div className="mb-2 text-sm text-gray-500 dark:text-gray-400">
                  <span className="text-gray-400 dark:text-gray-500">Days: </span>
                  <span className="text-gray-700 dark:text-gray-200">
                    {elapsedDays(stats.startDate)}
                  </span>
                </div>
              </>
            )}
            <ActionButton
              tone="primary"
              onClick={runFromMenu(() => handleFileSelect("audio"))}
            >
              Select Audio File
            </ActionButton>
            <ActionButton
              tone="primary"
              onClick={runFromMenu(() => handleFileSelect("subtitle"))}
            >
              Select SRT/VTT File
            </ActionButton>
            <ActionButton
              tone="primary"
              onClick={runFromMenu(openProjectPicker)}
            >
              Change Project
            </ActionButton>
            <ActionButton
              tone="slate"
              onClick={runFromMenu(toggleSplitScene)}
            >
              Split Scene
            </ActionButton>
            <ActionButton
              tone="slate"
              onClick={runFromMenu(copySegmentText)}
            >
              Copy Segment
            </ActionButton>
            <ActionButton tone="slate" onClick={runFromMenu(copySceneText)}>
              Copy Scene
            </ActionButton>
            <div className="mt-auto text-xs text-gray-400 dark:text-gray-500">
              Build: {buildTime}
            </div>
          </aside>
        </>
      )}

      {projectPickerOpen && (
        <>
          <div
            className="fixed inset-0 bg-black/50 z-50"
            onClick={() => setProjectPickerOpen(false)}
            aria-hidden="true"
          />
          <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none"
            role="dialog"
            aria-label="Select project"
          >
            <div className="pointer-events-auto w-full max-w-sm bg-white dark:bg-gray-900 rounded-lg shadow-xl flex flex-col max-h-[80vh]">
              <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-700">
                <h2 className="text-lg font-medium text-gray-700 dark:text-gray-200">
                  Select Project
                </h2>
                <button
                  onClick={() => setProjectPickerOpen(false)}
                  aria-label="Close"
                  className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-200 text-xl leading-none"
                >
                  ×
                </button>
              </div>
              <div className="overflow-y-auto p-2">
                {availableProjects.length === 0 ? (
                  <p className="p-4 text-center text-sm text-gray-500 dark:text-gray-400">
                    No projects yet. Use Select Audio File to create one.
                  </p>
                ) : (
                  <ul className="flex flex-col">
                    {availableProjects.map((name) => {
                      const isCurrent = name === project;
                      return (
                        <li key={name}>
                          <button
                            onClick={() => selectProject(name)}
                            className={`w-full text-left px-4 py-3 rounded-md transition-colors truncate ${
                              isCurrent
                                ? "bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 font-medium"
                                : "hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-200"
                            }`}
                          >
                            {name}
                            {isCurrent && (
                              <span className="ml-2 text-xs">(current)</span>
                            )}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </main>
  );
}
