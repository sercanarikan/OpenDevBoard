import React from 'react';
import dashboardGrid from '../../assets/dashboard-grid.svg';

type BrandLogoProps = {
  className?: string;
  'aria-hidden'?: boolean | 'true' | 'false';
};

export const BrandLogo: React.FC<BrandLogoProps> = ({ className, 'aria-hidden': ariaHidden }) => (
  <img
    src={dashboardGrid}
    alt=""
    aria-hidden={ariaHidden}
    className={className}
    draggable={false}
  />
);
