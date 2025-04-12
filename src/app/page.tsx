"use client";

import { useState, useRef } from "react";
import srtParser from "srt-parser-2";

const OPFS_AUDIO_NAME = "audio.mp3";
const OPFS_SRT_NAME = "transcript.srt";

const opfsWrite = async (file: File, fileName: string) => {
  const root = await navigator.storage.getDirectory();

  const opfsFileHandle = await root.getFileHandle(fileName, { create: true });
  const writable = await opfsFileHandle.createWritable();

  await writable.write(file);
  await writable.close();
};

export const opfsRead = async (fileName: string) => {
  const root = await navigator.storage.getDirectory();

  const opfsFileHandle = await root.getFileHandle(fileName);
  const ab = (await opfsFileHandle.getFile()).arrayBuffer();
  return ab;
};

interface Segment {
  startTime: number;
  endTime: number;
  text: string;
}

const createSegmentBuffer = (
  ctx: AudioContext,
  sourceBuffer: AudioBuffer,
  startSec: number,
  durationSec: number
): AudioBuffer => {
  const sampleRate = sourceBuffer.sampleRate;
  const numberOfChannels = sourceBuffer.numberOfChannels;

  window.console.log(
    `sampleRate: ${sampleRate}, channels: ${numberOfChannels}, audioCtx ${ctx.sampleRate}`
  );

  const segmentBuffer = ctx.createBuffer(
    numberOfChannels,
    Math.floor(durationSec * sampleRate),
    sampleRate
  );

  // Copy the segment data from the original buffer to the new buffer
  for (let channel = 0; channel < numberOfChannels; channel++) {
    segmentBuffer.copyToChannel(
      sourceBuffer
        .getChannelData(channel)
        .subarray(
          Math.floor(startSec * sampleRate),
          Math.floor(startSec * sampleRate) +
            Math.floor(durationSec * sampleRate)
        ),
      channel,
      0
    );
  }

  return segmentBuffer;
};

export default function Home() {
  const [status, setStatus] = useState<string>("");
  const [isPlaying, setIsPlaying] = useState(false);
  const audioContextRef = useRef<AudioContext | undefined>(undefined);
  const sourceNodeRef = useRef<AudioBufferSourceNode | undefined>(undefined);
  const audioBufferRef = useRef<AudioBuffer | undefined>(undefined);
  const [segments, setSegments] = useState<Segment[]>([]);

  const stopPlayback = () => {
    if (!sourceNodeRef) {
      return;
    }
    sourceNodeRef.current?.stop();
    sourceNodeRef.current = undefined;
    setIsPlaying(false);
  };

  const playAudioSegment = async (index: number) => {
    try {
      if (!audioContextRef.current || !audioBufferRef.current) return;
      stopPlayback();

      const ctx = audioContextRef.current;
      const segment = segments[index];
      if (!segment) {
        return;
      }
      const startSec = segment.startTime;
      const durationSec = segment.endTime - segment.startTime;

      const segmentBuffer = createSegmentBuffer(
        ctx,
        audioBufferRef.current,
        startSec,
        durationSec
      );

      // Create and set up source node
      const source = ctx.createBufferSource();
      source.buffer = segmentBuffer; // Use the smaller segment buffer
      source.connect(ctx.destination);
      source.loop = true;

      // Store source node for later stopping
      sourceNodeRef.current = source;

      // Start playing from the beginning of the segment buffer
      source.start();
      setIsPlaying(true);
      setStatus("Playing audio segment in loop...");
    } catch (error) {
      console.error("Error playing audio:", error);
      setStatus("Error playing audio segment");
      setIsPlaying(false);
    }
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
                  accept: { "text/plain": [".srt"] },
                },
              ],
      });

      const file = await fileHandle.getFile();
      // Only save to OPFS if it's an audio file
      await opfsWrite(
        file,
        input === "audio" ? OPFS_AUDIO_NAME : OPFS_SRT_NAME
      );
    } catch (error) {
      console.error("Error handling file:", error);
      setStatus(`Error processing ${input} file`);
    }
  };

  // Stop any current playback
  const handleFileLoad = async () => {
    stopPlayback();

    // Create AudioContext if it doesn't exist
    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContext();
    }

    // Read and decode the audio file
    const arrayBuffer = await opfsRead(OPFS_AUDIO_NAME);
    const audioBuffer = await audioContextRef.current.decodeAudioData(
      arrayBuffer
    );

    window.console.log("audio buffer loaded.");
    // Store the decoded audio buffer
    audioBufferRef.current = audioBuffer;

    const srtContent = await opfsRead(OPFS_SRT_NAME);
    const decoder = new TextDecoder();
    const srtString = decoder.decode(await srtContent);

    const parser = new srtParser();
    const segments: Segment[] = parser.fromSrt(srtString).map((elem) => ({
      startTime: elem.startSeconds,
      endTime: elem.endSeconds,
      text: elem.text,
    }));
    window.console.log(segments);
    setSegments(segments);

    setStatus("Audio loaded. Click Play to start loop.");
  };

  return (
    <main className="min-h-screen flex items-center justify-center">
      <div className="flex flex-col items-center gap-4 p-8">
        <div className="flex gap-4">
          <button
            onClick={() => handleFileSelect("audio")}
            className="cursor-pointer bg-blue-500 hover:bg-blue-600 text-white px-6 py-3 rounded-lg font-medium transition-colors"
          >
            Select Audio File
          </button>
          <button
            onClick={() => handleFileSelect("srt")}
            className="cursor-pointer bg-blue-500 hover:bg-blue-600 text-white px-6 py-3 rounded-lg font-medium transition-colors"
          >
            Select SRT File
          </button>
          <button
            onClick={handleFileLoad}
            className="cursor-pointer bg-blue-500 hover:bg-blue-600 text-white px-6 py-3 rounded-lg font-medium transition-colors"
          >
            Load
          </button>
        </div>
        {audioBufferRef.current && (
          <div className="flex gap-4">
            <button
              onClick={stopPlayback}
              className={`cursor-pointer ${
                isPlaying
                  ? "bg-red-500 hover:bg-red-600"
                  : "bg-green-500 hover:bg-green-600"
              } text-white px-6 py-3 rounded-lg font-medium transition-colors`}
            >
              {"Stop"}
            </button>
          </div>
        )}
        {status && (
          <p className="text-sm text-gray-600 dark:text-gray-400">{status}</p>
        )}
        {segments.length > 0 && (
          <div className="mt-4 w-full max-w-2xl">
            <table className="w-full border-collapse">
              <thead>
                <tr className="bg-gray-100 dark:bg-gray-800">
                  <th className="p-2 text-left">Text</th>
                  <th className="p-2 w-24"></th>
                </tr>
              </thead>
              <tbody>
                {segments.map((segment, index) => (
                  <tr
                    key={index}
                    className="border-t border-gray-200 dark:border-gray-700"
                  >
                    <td className="p-2">{segment.text}</td>
                    <td className="p-2">
                      <button
                        className="bg-blue-500 hover:bg-blue-600 text-white px-3 py-1 rounded text-sm transition-colors"
                        onClick={() => playAudioSegment(index)}
                      >
                        Play
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  );
}
