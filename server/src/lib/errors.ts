/** Erro com mensagem em português e orientação de como resolver. */
export class AppError extends Error {
  status: number;
  hint: string;
  code: string;
  constructor(status: number, message: string, hint = '', code = 'erro') {
    super(message);
    this.status = status;
    this.hint = hint;
    this.code = code;
  }
}

export const notFound = (what: string) => new AppError(404, `${what} não encontrado(a).`, 'Atualize a página. Se o item foi excluído, volte à lista.', 'nao_encontrado');
export const badRequest = (msg: string, hint = '') => new AppError(400, msg, hint, 'dados_invalidos');
