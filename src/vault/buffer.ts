import { contract } from '../utils/contract';

const buffer = contract('buffer');

export const getBufferTotal = () => buffer().read.total();
