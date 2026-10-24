import React from 'react';
import logoUrl from '../../assets/brand/checkin-logo.png';

/**
 * Hero illustration: a stylised vector biometric terminal under the floating approved CheckIn logo, joined by a faint light beam and thin data
 * streams. It is an original vector drawing (not a photograph or a rendered 3D model): depth comes from stacked copies of the
 * symbol, a beam and a floor glow. All motion is CSS transform / opacity / dash-offset (see styles/checkin-launcher.css) and is
 * switched off by prefers-reduced-motion.
 */
export default function LauncherHero({ animate = true, className = '', style }) {
  return (
    <svg
      viewBox="0 0 360 300" role="img" aria-label="CheckIn" className={`ci-anim ${className}`.trim()}
      style={{ width: '100%', maxWidth: 380, height: 'auto', display: 'block', ...style }}
    >
      <defs>
        <linearGradient id="ci-hero-body" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#262626" /><stop offset="1" stopColor="#151515" />
        </linearGradient>
        <linearGradient id="ci-hero-beam" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0" stopColor="#4FBF6B" stopOpacity="0.30" /><stop offset="1" stopColor="#4FBF6B" stopOpacity="0" />
        </linearGradient>
        <radialGradient id="ci-hero-floor" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#4FBF6B" stopOpacity="0.16" /><stop offset="1" stopColor="#4FBF6B" stopOpacity="0" />
        </radialGradient>
        <clipPath id="ci-hero-sensor-clip"><circle cx="180" cy="214" r="28" /></clipPath>
      </defs>

      {/* floor glow */}
      <ellipse cx="180" cy="276" rx="120" ry="16" fill="url(#ci-hero-floor)" />

      {/* data streams (thin, decorative: they show the idea of data leaving the terminal, not live traffic) */}
      <g fill="none" stroke="#4FBF6B" strokeWidth="1" opacity="0.55" strokeLinecap="round">
        {animate ? <>
          <path className="ci-stream" d="M120 196C80 196 54 168 18 168" />
          <path className="ci-stream" d="M240 196C280 196 306 168 342 168" />
          <path className="ci-stream" d="M120 236C84 236 54 256 18 256" />
          <path className="ci-stream" d="M240 236C276 236 306 256 342 256" />
        </> : <>
          <path d="M120 196C80 196 54 168 18 168" /><path d="M240 196C280 196 306 168 342 168" />
          <path d="M120 236C84 236 54 256 18 256" /><path d="M240 236C276 236 306 256 342 256" />
        </>}
      </g>
      <g fill="#4FBF6B" opacity="0.7">
        <circle cx="18" cy="168" r="2.2" /><circle cx="342" cy="168" r="2.2" /><circle cx="18" cy="256" r="2.2" /><circle cx="342" cy="256" r="2.2" />
      </g>

      {/* light beam from the sensor to the symbol */}
      <polygon points="158,184 202,184 222,100 138,100" fill="url(#ci-hero-beam)" />

      {/* terminal body */}
      <rect x="120" y="128" width="120" height="146" rx="16" fill="url(#ci-hero-body)" stroke="#2D2D2D" />
      <rect x="132" y="140" width="96" height="40" rx="7" fill="#090909" stroke="#2D2D2D" />
      <g fill="#404040"><rect x="140" y="150" width="40" height="4" rx="2" /><rect x="140" y="160" width="62" height="4" rx="2" /><rect x="140" y="169" width="28" height="4" rx="2" /></g>
      <circle cx="218" cy="150" r="3" fill="#4FBF6B" />

      {/* fingerprint sensor: decorative concentric ridges + scan line */}
      <circle cx="180" cy="214" r="31" fill="#090909" stroke="#4FBF6B" strokeOpacity="0.45" />
      <g fill="none" stroke="#4FBF6B" strokeOpacity="0.5" strokeWidth="1.6" strokeLinecap="round">
        <path d="M164 214a16 16 0 0 1 32 0" /><path d="M158 218a22 22 0 0 1 44 0" /><path d="M170 214a10 10 0 0 1 20 0" />
        <path d="M168 222a12 12 0 0 0 24 0" /><path d="M162 226a18 18 0 0 0 36 0" />
      </g>
      <g clipPath="url(#ci-hero-sensor-clip)">
        <rect className={animate ? 'ci-scan' : undefined} x="148" y="213" width="64" height="2.5" fill="#4FBF6B" opacity="0.9" />
      </g>

      {/* approved logo (exact artwork) on a white tile, floating above the terminal */}
      <g className={animate ? 'ci-float' : undefined}>
        <rect x="118" y="2" width="124" height="124" rx="28" fill="#FFFFFF" />
        <image href={logoUrl} x="128" y="12" width="104" height="104" preserveAspectRatio="xMidYMid meet" />
      </g>
    </svg>
  );
}
