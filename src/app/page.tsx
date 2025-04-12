"use client";

import { useState, useRef } from "react";

const OPFS_AUDIO_NAME = "audio.mp3";

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

export default function Home() {
  const [status, setStatus] = useState<string>("");
  const [isPlaying, setIsPlaying] = useState(false);
  const audioContextRef = useRef<AudioContext | undefined>(undefined);
  const sourceNodeRef = useRef<AudioBufferSourceNode | undefined>(undefined);
  const audioBufferRef = useRef<AudioBuffer | undefined>(undefined);

  const stopPlayback = () => {
    if (!sourceNodeRef) {
      return;
    }
    sourceNodeRef.current?.stop();
    sourceNodeRef.current = undefined;
    setIsPlaying(false);
  };

  const playAudioSegment = async () => {
    try {
      if (!audioContextRef.current || !audioBufferRef.current) return;
      // Stop current playback if any
      stopPlayback();

      const ctx = audioContextRef.current;

      // Create a new buffer for the segment (20 - 0.5 = 19.5 seconds)
      const startSec = 258;
      const durationSec = 2.42;
      const sampleRate = audioBufferRef.current.sampleRate;
      const numberOfChannels = audioBufferRef.current.numberOfChannels;
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
          audioBufferRef.current
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

      window.console.log("segBuf is set");

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

  const handleFileSelect = async () => {
    try {
      const [fileHandle] = await window.showOpenFilePicker({
        types: [
          {
            description: "Audio Files",
            accept: {
              "audio/*": [".mp3", ".wav", ".m4a", ".ogg"],
            },
          },
        ],
      });

      const file = await fileHandle.getFile();
      await opfsWrite(file, OPFS_AUDIO_NAME);
    } catch (error) {
      console.error("Error handling file:", error);
      setStatus("Error processing audio file");
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

    setStatus("Audio loaded. Click Play to start loop.");
  };

  return (
    <main className="min-h-screen flex items-center justify-center">
      <div className="flex flex-col items-center gap-4 p-8">
        <button
          onClick={handleFileSelect}
          className="cursor-pointer bg-blue-500 hover:bg-blue-600 text-white px-6 py-3 rounded-lg font-medium transition-colors"
        >
          Select Audio File
        </button>

        <button
          onClick={handleFileLoad}
          className="cursor-pointer bg-blue-500 hover:bg-blue-600 text-white px-6 py-3 rounded-lg font-medium transition-colors"
        >
          Load
        </button>

        {audioBufferRef.current && (
          <div className="flex gap-4">
            <button
              onClick={isPlaying ? stopPlayback : playAudioSegment}
              className={`cursor-pointer ${
                isPlaying
                  ? "bg-red-500 hover:bg-red-600"
                  : "bg-green-500 hover:bg-green-600"
              } text-white px-6 py-3 rounded-lg font-medium transition-colors`}
            >
              {isPlaying ? "Stop" : "Play Loop"}
            </button>
          </div>
        )}

        {status && (
          <p className="text-sm text-gray-600 dark:text-gray-400">{status}</p>
        )}
      </div>
    </main>
  );
}
