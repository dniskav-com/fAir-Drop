export interface Theme {
  name: string
  borderDim: string
  borderFocus: string
  bg: string
  fg: string
  accent: string
  success: string
  warning: string
  error: string
  dim: string
  selectedBg: string
  selectedFg: string
  inputBg: string
}

export const THEMES: Record<string, Theme> = {
  dark: {
    name: 'Oscuro',
    borderDim: 'blue',
    borderFocus: 'white',
    bg: '',       // vacío = fondo nativo del terminal (negro real)
    fg: 'white',
    accent: 'cyan',
    success: 'green',
    warning: 'yellow',
    error: 'red',
    dim: 'gray',
    selectedBg: 'blue',
    selectedFg: 'white',
    inputBg: '',
  },
  light: {
    name: 'Claro',
    borderDim: 'gray',
    borderFocus: 'blue',
    bg: 'white',
    fg: 'black',
    accent: 'blue',
    success: 'green',
    warning: 'magenta',
    error: 'red',
    dim: 'gray',
    selectedBg: 'blue',
    selectedFg: 'white',
    inputBg: 'white',
  },
}
