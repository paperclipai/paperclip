import React, {useEffect, useRef} from 'react';

type Particle = {
  x: number;
  y: number;
  size: number;
  speedX: number;
  speedY: number;
  life: number;
  color: string;
};

function createParticle(width: number, height: number, palette: string[]): Particle {
  return {
    x: Math.random() * width,
    y: Math.random() * height,
    size: Math.random() * 1.5 + 0.2,
    speedX: (Math.random() - 0.5) * 0.35,
    speedY: (Math.random() - 0.5) * 0.35,
    life: Math.random() * 100,
    color: palette[Math.floor(Math.random() * palette.length)] ?? '#22d3ee',
  };
}

export default function Root({children}: {children: React.ReactNode}): React.ReactNode {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const context = canvas.getContext('2d');
    if (!context) {
      return;
    }

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const palette = ['#8b5cf6', '#22d3ee', '#ec4899'];
    const density = reducedMotion ? 18 : 64;
    const particles: Particle[] = [];
    let rafId = 0;

    const resize = () => {
      const width = window.innerWidth;
      const height = window.innerHeight;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);

      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const refillParticles = () => {
      particles.length = 0;
      for (let i = 0; i < density; i += 1) {
        particles.push(createParticle(window.innerWidth, window.innerHeight, palette));
      }
    };

    const drawFrame = () => {
      const width = window.innerWidth;
      const height = window.innerHeight;
      context.clearRect(0, 0, width, height);

      for (let i = 0; i < particles.length; i += 1) {
        const particle = particles[i];
        if (!particle) {
          continue;
        }

        particle.x += particle.speedX;
        particle.y += particle.speedY;
        particle.life -= reducedMotion ? 0.2 : 0.07;

        if (
          particle.life <= 0 ||
          particle.x < -20 ||
          particle.x > width + 20 ||
          particle.y < -20 ||
          particle.y > height + 20
        ) {
          particles[i] = createParticle(width, height, palette);
          continue;
        }

        context.globalAlpha = (particle.life / 100) * (reducedMotion ? 0.15 : 0.3);
        context.fillStyle = particle.color;
        context.beginPath();
        context.arc(particle.x, particle.y, particle.size, 0, Math.PI * 2);
        context.fill();
      }

      if (!reducedMotion) {
        rafId = window.requestAnimationFrame(drawFrame);
      }
    };

    resize();
    refillParticles();
    drawFrame();

    const onResize = () => {
      resize();
      refillParticles();
      if (reducedMotion) {
        drawFrame();
      }
    };

    window.addEventListener('resize', onResize);

    return () => {
      window.removeEventListener('resize', onResize);
      if (rafId) {
        window.cancelAnimationFrame(rafId);
      }
    };
  }, []);

  return (
    <>
      <div className="spirit-ambient" aria-hidden="true" />
      <canvas id="spirit-canvas" ref={canvasRef} aria-hidden="true" />
      {children}
    </>
  );
}
