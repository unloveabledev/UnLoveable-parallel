import React from 'react';

interface OpenChamberLogoProps {
  className?: string;
  width?: number;
  height?: number;
  isAnimated?: boolean;
}

export const OpenChamberLogo: React.FC<OpenChamberLogoProps> = ({
  className = '',
  width = 70,
  height = 70,
  isAnimated = false,
}) => {
  return (
    <img
      src="/UnLogo.png"
      alt="UnLoveable logo"
      width={width}
      height={height}
      className={className}
      style={
        isAnimated
          ? {
              animation: 'logo-pulse 2.2s ease-in-out infinite',
              transformOrigin: 'center',
            }
          : undefined
      }
      loading="eager"
      decoding="async"
    />
  );
};
