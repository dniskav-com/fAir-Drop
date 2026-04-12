import React from 'react'

type BrandMarkProps = {
  onClick?: (e: React.MouseEvent<HTMLSpanElement>) => void
  pressed?: boolean
  id?: string
  className?: string
}

export default function BrandMark({
  onClick,
  pressed = false,
  id = 'brand-mark',
  className = '',
}: BrandMarkProps) {
  return (
    <span
      id={id}
      className={['brand-mark', className].filter(Boolean).join(' ')}
      role="button"
      aria-pressed={pressed}
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onClick?.(e as unknown as React.MouseEvent<HTMLSpanElement>)
        }
      }}
    >
      <span className="radar-ring"></span>
      <span className="radar-ring"></span>
      <span className="radar-ring"></span>
      <span className="radar-core"></span>
    </span>
  )
}
