const dniRegex = /^[0-9]{8}[A-Z]$/i;
const cifRegex = /^[ABCDEFGHJNPQRSUVW][0-9]{7}[0-9A-J]$/i;
const nieRegex = /^[XYZ][0-9]{7}[A-Z]$/i;

export const isValidSpanishNif = (value: string | null | undefined): boolean => {
  if (!value) {
    return false;
  }
  const upper = value.toUpperCase().replace(/\s|-/g, '');
  return dniRegex.test(upper) || cifRegex.test(upper) || nieRegex.test(upper);
};
