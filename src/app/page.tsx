"use client";

import { useState, useRef, useEffect } from "react";
import srtParser from "srt-parser-2";
import { opfsClearAll, opfsExist, opfsRead, opfsWrite } from "./util/opfs";
import { AudioSample, splitMp3Segments } from "./util/sample";

const LS_INDEX = "lastPlayIndex";
const SCENE_TAG = /^\[SCENE] /;

const loadPlayIndex = () => {
  if (window.localStorage) {
    const idxStr = window.localStorage.getItem(LS_INDEX);
    if (!idxStr) return 0;
    return parseInt(idxStr);
  }
  return 0;
};

const getRowId = (index: number) => `id-${index}`;

const savePlayIndex = (index: number) => {
  if (window.localStorage) {
    window.localStorage.setItem(LS_INDEX, index.toString());
  }
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

const OPFS_AUDIO_NAME = "audio.mp3";
const OPFS_SRT_NAME = "transcript.srt";

interface Segment {
  startTime: number;
  endTime: number;
  text: string;
  sceneIdx: number;
}

interface RangeInfo {
  type: "scene" | "selected";
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

export default function Home() {
  const [status, setStatus] = useState<string>("");
  const playCtxRef = useRef<PlayContext | undefined>(undefined);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [segIndex, setSegIndex] = useState<number>(0);
  const [scenes, setScenes] = useState<number>(0);
  const [selectionMode, setSelectionMode] = useState<boolean>(false);
  const [selectedItems, setSelectedItems] = useState<Set<number>>(new Set());

  useEffect(() => {
    const audioContext = new AudioContext();
    const audioSample = new AudioSample(audioContext, setStatus);
    const playContext: PlayContext = { audioContext, audioSample };
    playCtxRef.current = playContext;

    const lastIdx = loadPlayIndex();
    setSegIndex(lastIdx);

    (async () => {
      const loaded = await audioSample.initSample(setStatus);
      if (!loaded) {
        setStatus(`No sample found`);
        return;
      }

      if (!(await opfsExist(OPFS_SRT_NAME))) {
        setStatus(`No srt`);
        return;
      }

      const srtContent = await opfsRead(OPFS_SRT_NAME);
      const decoder = new TextDecoder();
      const srtString = decoder.decode(srtContent);
      setStatus("srt file found. setting.");

      let sceneIdx = -1;

      const parser = new srtParser();
      const segments: Segment[] = parser
        .fromSrt(srtString)
        .map((elem) => {
          const { startSeconds, endSeconds, text } = elem;

          const revisedText = text.replace(SCENE_TAG, "");
          if (SCENE_TAG.test(text)) {
            ++sceneIdx;
          }

          return {
            startMsec: Math.round(startSeconds * 1000),
            endMsec: Math.round(endSeconds * 1000),
            text: revisedText,
            sceneIdx,
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
            sceneIdx: elem.sceneIdx,
          };
        });
      setSegments(segments);
      setScenes(sceneIdx);
      setStatus(`current: ${lastIdx + 1} / ${segments.length}`);
    })();
  }, []);

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
      const sceneIdx = segment.sceneIdx;

      setSegIndex(index);
      savePlayIndex(index);

      const abSrcNode = audioContext.createBufferSource();

      const segmentBuffer = await audioSample.createSegmentBuffer(
        startSec,
        durationSec
      );

      abSrcNode.buffer = segmentBuffer; // Use the smaller segment buffer
      abSrcNode.connect(audioContext.destination);
      abSrcNode.loop = singleEntryLoop;

      let stopListener: undefined | (() => void) = undefined;
      let rangeInfo: RangeInfo | undefined = undefined;

      if (singleEntryLoop === false) {
        const sceneBeginIdx = segments.findIndex(
          (elem) => elem.sceneIdx === sceneIdx
        );
        const sceneEndIdx = segments.findIndex(
          (elem) => elem.sceneIdx === sceneIdx + 1
        );
        const newBeginIdx = sceneBeginIdx === -1 ? index : sceneBeginIdx;
        const newEndIdx = sceneEndIdx === -1 ? segments.length : sceneEndIdx;
        rangeInfo = initRangeInfo
          ? initRangeInfo
          : prevRangeInfo
          ? prevRangeInfo
          : { beginIdx: newBeginIdx, endIdx: newEndIdx, type: "scene" };
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
      const playBeep =
        rangeInfo && rangeInfo.type === "scene" && rangeInfo.beginIdx === index;
      if (playBeep) {
        beep(audioContext, () => abSrcNode.start());
      } else {
        abSrcNode.start();
      }

      const rangeStr = rangeInfo
        ? `[${rangeInfo.beginIdx + 1}~${rangeInfo.endIdx}][${
            sceneIdx + 1
          }/${scenes}]`
        : "";
      setStatus(`current: ${index + 1} / ${segments.length} ${rangeStr}`);

      if (rangeInfo?.type !== "selected") {
        document
          .getElementById(getRowId(index))
          ?.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    } catch (error) {
      console.error("Error playing audio:", error);
      setStatus("Error playing audio segment");
    }
  };

  const toggleSelection = (index: number) => {
    if (!selectionMode) return;

    setSelectedItems((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(index)) {
        newSet.delete(index);
      } else {
        newSet.add(index);
      }
      return newSet;
    });
  };

  const playSelectedItems = async () => {
    if (selectedItems.size === 0) return;

    const selectedArray = Array.from(selectedItems).sort((a, b) => a - b);
    setSelectionMode(false);
    setSelectedItems(new Set());

    const initRangeInfo: RangeInfo = {
      beginIdx: selectedArray[0],
      endIdx: selectedArray[selectedArray.length - 1] + 1,
      type: "selected",
    };

    await playAudioSegment(selectedArray[0], false, initRangeInfo);
  };

  const cancelSelection = () => {
    setSelectionMode(false);
    setSelectedItems(new Set());
  };

  const handleFileSelect = async (input: "audio" | "srt") => {
    try {
      const [fileHandle] = await window.showOpenFilePicker({
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
                    "text/plain": [".srt"],
                    "application/x-subrip": [".srt"],
                    "text/srt": [".srt"],
                    "application/srt": [".srt"],
                  },
                },
              ],
      });

      const file = await fileHandle.getFile();
      if (input === "audio") {
        await opfsClearAll("mp3");
      }
      await opfsWrite(
        input === "audio" ? OPFS_AUDIO_NAME : OPFS_SRT_NAME,
        file
      );

      if (input === "audio" && playCtx) {
        setStatus(`decoding audio`);
        const arrayBuffer = await opfsRead(OPFS_AUDIO_NAME);
        const audioBuffer = await playCtx?.audioContext.decodeAudioData(
          arrayBuffer
        );

        await splitMp3Segments(audioBuffer, setStatus);
      }
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

  return (
    <main className="min-h-screen flex items-center justify-center py-4 sm:py-8">
      <div className="flex flex-col items-center gap-4 w-full">
        <div className="flex flex-col sm:flex-row gap-4 w-full">
          <button
            onClick={() => handleFileSelect("audio")}
            className="cursor-pointer bg-blue-500 hover:bg-blue-600 text-white px-4 sm:px-6 py-3 rounded-lg font-medium transition-colors flex-1 sm:flex-none"
          >
            Select Audio File
          </button>
          <button
            onClick={() => handleFileSelect("srt")}
            className="cursor-pointer bg-blue-500 hover:bg-blue-600 text-white px-4 sm:px-6 py-3 rounded-lg font-medium transition-colors flex-1 sm:flex-none"
          >
            Select SRT File
          </button>
        </div>

        <div className="sticky top-0 z-10 bg-white dark:bg-gray-900 py-4 w-full flex flex-col items-center gap-4">
          {isLoaded && (
            <div className="flex gap-4">
              {selectionMode ? (
                <>
                  <button
                    onClick={playSelectedItems}
                    className="cursor-pointer bg-green-500 hover:bg-green-600 text-white px-6 py-3 rounded-lg font-medium transition-colors"
                  >
                    Play Selected ({selectedItems.size})
                  </button>
                  <button
                    onClick={cancelSelection}
                    className="cursor-pointer bg-gray-500 hover:bg-gray-600 text-white px-6 py-3 rounded-lg font-medium transition-colors"
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <button
                    onClick={() => {
                      if (playInfo) {
                        stopPlayback(playCtx);
                        setStatus(status + " stopped");
                      } else {
                        playAudioSegment(segIndex, false);
                      }
                    }}
                    className={`cursor-pointer ${
                      playInfo
                        ? "bg-red-500 hover:bg-red-600"
                        : "bg-green-500 hover:bg-green-600"
                    } text-white px-6 py-3 rounded-lg font-medium transition-colors`}
                  >
                    {playInfo ? "Stop" : "Play"}
                  </button>
                </>
              )}
            </div>
          )}
          <p className="text-lg sm:text-2xl text-gray-600 dark:text-gray-400 text-center">
            {status}
            {selectionMode && (
              <span className="block text-sm text-blue-500 mt-1">
                Selection Mode: {selectedItems.size} item(s) selected
              </span>
            )}
          </p>
          {isLoaded && (
            <div className="flex gap-4 sm:gap-8 w-full justify-center">
              <div
                onClick={() =>
                  segIndex > 0 && playAudioSegment(segIndex - 1, true)
                }
                className="cursor-pointer bg-blue-500 hover:bg-blue-600 px-2 sm:px-4 rounded-2xl font-medium transition-colors text-3xl sm:text-6xl border-2 border-blue-500 text-white flex-1 sm:flex-none text-center"
              >
                Prev
              </div>
              <div
                onClick={() =>
                  segIndex < segments.length - 1 &&
                  playAudioSegment(segIndex + 1, true)
                }
                className="cursor-pointer bg-blue-500 hover:bg-blue-600 px-2 sm:px-4 rounded-2xl font-medium transition-colors text-3xl sm:text-6xl border-2 border-blue-500 text-white flex-1 sm:flex-none text-center"
              >
                Next
              </div>
            </div>
          )}
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
                    segment.sceneIdx !== segments[index - 1]?.sceneIdx;
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
                        {selectionMode ? (
                          <input
                            type="checkbox"
                            checked={selectedItems.has(index)}
                            onChange={() => toggleSelection(index)}
                            className="w-4 h-4 text-blue-600 bg-gray-100 border-gray-300 rounded focus:ring-blue-500"
                          />
                        ) : (
                          index + 1
                        )}
                      </td>
                      <td className="p-1 sm:p-2 break-words min-w-0 select-text">
                        {segment.text}
                      </td>
                      <td className="p-1 sm:p-2 select-none">
                        <button
                          className={`px-1.5 py-0.5 rounded text-xs select-none flex items-center justify-center ${
                            selectionMode
                              ? "bg-gray-400 text-gray-200 cursor-not-allowed"
                              : "bg-blue-500 text-white"
                          }`}
                          onClick={() => playAudioSegment(index, true)}
                          onPointerDown={(e) => {
                            if (selectionMode) return;
                            e.persist?.();
                            const timeoutId = setTimeout(() => {
                              if (!selectionMode) {
                                setSelectionMode(true);
                                setSelectedItems(new Set([index]));
                              }
                            }, 500);
                            const clear = () => clearTimeout(timeoutId);
                            e.target.addEventListener("pointerup", clear, {
                              once: true,
                            });
                            e.target.addEventListener("pointerleave", clear, {
                              once: true,
                            });
                          }}
                          disabled={selectionMode}
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
    </main>
  );
}
