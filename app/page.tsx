export default function Home() {
  return (
    <main className="game-shell">
      <iframe
        className="game-frame"
        src="/game.html"
        title="Stop the Boats — Operation Tidebreak"
        allow="autoplay; fullscreen; web-share"
        allowFullScreen
      />
    </main>
  );
}
